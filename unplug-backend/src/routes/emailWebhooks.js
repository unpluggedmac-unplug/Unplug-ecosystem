// What the mail provider tells us afterwards: delivered, bounced, complained.
//
// WHY THIS IS ITS OWN FILE rather than another route in routes/email.js: the
// signature is computed over the RAW REQUEST BYTES, so this router has to be
// mounted ahead of the global express.json() with express.raw() of its own.
// That is a structural requirement, not a preference — once the body has been
// parsed and re-serialised the bytes have changed and a correct secret looks
// wrong. Keeping it separate makes the mounting order visible in app.js
// instead of hidden behind a middleware inside a shared router.
//
// WHAT THIS CLOSES. Before it, nothing in the codebase ever wrote a 'bounced'
// or 'complained' suppression. Both values existed in the schema and the
// reporting counted them, and both were always zero. A dead address was
// retried by every single campaign, for ever, and mailbox providers read
// repeated delivery to addresses that do not exist as the behaviour of a list
// that was never opted into. The sending reputation erodes quietly and the
// first visible symptom is legitimate mail landing in spam — including the
// password resets.
//
// THE ENDPOINT IS UNAUTHENTICATED BUT NOT UNVERIFIED, and the distinction is
// the whole point. Resend cannot log in, so there is no session to check; what
// it can do is sign. Every request is verified against the shared secret and
// nothing else is accepted. An unsigned version of this endpoint would be a
// remote denial-of-mail: anybody who found the URL could POST 'bounced' for
// every subscriber in turn and silently kill the list, and it would look like
// a deliverability problem for weeks before anybody suspected an attack.

const express = require('express');
const pool = require('../db');
const marketing = require('../utils/emailMarketing');
const svix = require('../utils/svixSignature');

const router = express.Router();

// 256kb is far more than any of these payloads, and small enough that the
// endpoint cannot be used to push a large body into a 512 MB instance.
router.use(express.raw({ type: '*/*', limit: '256kb' }));

let warnedNoSecret = false;

// Finds the send a webhook is about.
//
// BY PROVIDER ID FIRST, because that identifies one message. Falling back to
// the address alone would attribute a bounce to whichever message happened to
// be most recent, which is usually right and occasionally credits the wrong
// campaign — so the fallback is deliberately last, and only used when the
// provider did not give us an id to match on.
async function findSend(providerId, email) {
  if (providerId) {
    const byId = await pool.query('SELECT * FROM email_sends WHERE provider_id = $1 LIMIT 1', [providerId]);
    if (byId.rowCount) return byId.rows[0];
  }
  if (!email) return null;
  const byEmail = await pool.query(
    `SELECT * FROM email_sends WHERE LOWER(email) = $1 ORDER BY id DESC LIMIT 1`,
    [marketing.normalise(email)]);
  return byEmail.rowCount ? byEmail.rows[0] : null;
}

// One event row per send per kind. Svix retries a webhook until it gets a 2xx,
// so the same delivery notice arrives several times as a matter of course —
// counting each would inflate every number in the reporting.
async function recordOnce(sendId, kind, url) {
  if (!sendId) return;
  // The casts are load-bearing. Each parameter appears both in the SELECT list
  // (where it has no context to infer a type from) and in the WHERE clause
  // (where it is compared to a column), and Postgres refuses the statement
  // outright with "inconsistent types deduced for parameter $2" rather than
  // guessing. Without them every webhook returns 500 and Svix retries for ever.
  await pool.query(
    `INSERT INTO email_events (send_id, kind, url)
     SELECT $1::integer, $2::varchar, $3::text
      WHERE NOT EXISTS (
        SELECT 1 FROM email_events WHERE send_id = $1::integer AND kind = $2::varchar)`,
    [sendId, kind, url || null]);
}

// A SOFT BOUNCE IS NOT A DEAD ADDRESS, and treating it as one is how a list
// loses real readers.
//
// A full mailbox, a server having a bad afternoon, a greylisting delay — all
// of those are transient, and all of them report as a bounce. Suppressing on
// the first one would permanently remove somebody whose inbox was full on a
// Tuesday. Only a permanent failure — the address does not exist, the domain
// does not exist — means never send here again.
//
// Resend labels this in data.bounce.type ('Permanent' / 'Transient'), and
// older payloads do not carry it at all. WHEN IT IS ABSENT THE BOUNCE IS
// TREATED AS SOFT: the cost of being wrong in that direction is one wasted
// send, and the cost of being wrong in the other is losing a reader for good.
function isPermanentBounce(data) {
  const bounce = data && data.bounce;
  if (!bounce) return false;
  const type = String(bounce.type || bounce.bounceType || '').toLowerCase();
  if (type === 'permanent' || type === 'hard') return true;
  // Amazon SES vocabulary, which Resend passes through on some payloads. The
  // subtype can say the address does not exist even where the type field is
  // absent, and those two values mean exactly that.
  const subtype = String(bounce.subType || bounce.subtype || '').toLowerCase();
  return subtype === 'nonexistent' || subtype === 'suppressed';
}

router.post('/resend', async (req, res) => {
  const secret = process.env.RESEND_WEBHOOK_SECRET;

  if (!secret) {
    // Said once, then quiet. An error on every webhook is a log nobody reads,
    // and this is a configuration gap rather than a fault.
    if (!warnedNoSecret) {
      console.warn('[email] RESEND_WEBHOOK_SECRET is not set — bounce and complaint '
        + 'webhooks are being refused, so dead addresses will keep being retried.');
      warnedNoSecret = true;
    }
    return res.status(503).json({ error: 'Webhooks are not configured.' });
  }

  const check = svix.verify({ body: req.body, headers: req.headers, secret });
  if (!check.ok) {
    console.warn('[email] rejected a webhook:', check.reason);
    return res.status(401).json({ error: 'Not verified.' });
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : req.body);
  } catch (err) {
    return res.status(400).json({ error: 'That is not JSON.' });
  }

  const type = String(payload && payload.type || '');
  const data = (payload && payload.data) || {};
  const address = Array.isArray(data.to) ? data.to[0] : data.to;

  try {
    const send = await findSend(data.email_id, address);

    if (type === 'email.delivered') {
      await recordOnce(send && send.id, 'delivered');

    } else if (type === 'email.bounced') {
      await recordOnce(send && send.id, 'bounce');
      if (address && isPermanentBounce(data)) {
        await marketing.suppress(address, 'bounced',
          String((data.bounce && (data.bounce.message || data.bounce.subType)) || 'permanent failure').slice(0, 200));
        // The sequences stop too. Carrying on through five more steps to an
        // address that does not exist is five more failures against the
        // sending reputation for no possible benefit.
        await marketing.cancelEnrolments(address, 'bounced');
      }

    } else if (type === 'email.complained') {
      await recordOnce(send && send.id, 'complaint');
      if (address) {
        // NO SOFT/HARD DISTINCTION HERE, and no second chance. Somebody
        // pressed the spam button. Mailing them again is both the rudest
        // thing this system could do and the fastest way to lose the domain.
        await marketing.suppress(address, 'complained', 'marked a message as spam');
        await marketing.cancelEnrolments(address, 'complained');
      }
    }
    // email.sent, email.opened, email.clicked and email.delivery_delayed are
    // deliberately ignored. Opens and clicks are already measured by this
    // system's own pixel and redirect; recording the provider's version as
    // well would double every number in the reporting.

    res.json({ ok: true });
  } catch (err) {
    console.error('[email] webhook handling failed:', err.message);
    // 500 rather than 200, so Svix retries. Silently swallowing a failure here
    // loses a bounce permanently, and a lost bounce is an address that keeps
    // being mailed.
    res.status(500).json({ error: 'Could not record that.' });
  }
});

module.exports = router;
