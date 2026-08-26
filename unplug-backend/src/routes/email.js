// Unsubscribing, preferences, and the tracking endpoints.
//
// EVERYTHING HERE IS PUBLIC AND UNAUTHENTICATED, and it has to be. Somebody
// who wants to stop receiving mail is holding a link in an email, not a
// password. Requiring them to sign in to unsubscribe is the same as not
// letting them unsubscribe, and they will press the spam button instead.
//
// The token in each link is random per message and stored, so it identifies
// one send without being guessable from an address.

const express = require('express');
const pool = require('../db');
const marketing = require('../utils/emailMarketing');

const router = express.Router();

const SITE_URL = (process.env.SITE_URL || 'https://www.unplugnews.com').replace(/\/$/, '');

// A plain page, self-contained, because somebody following an unsubscribe link
// may be in a webmail preview pane with no styles and no patience.
function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — Unplug Magazine</title>
<style>
  body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#f1f0ef;color:#272626;
       margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;}
  .card{background:#fff;border-radius:12px;padding:32px;max-width:460px;box-shadow:0 4px 16px rgba(15,14,14,.1);}
  h1{font-size:22px;margin:0 0 12px;} p{line-height:1.6;color:#454545;margin:0 0 12px;}
  a{color:#d20709;} .muted{font-size:13px;color:#6b6b6b;}
</style></head><body><div class="card">${body}</div></body></html>`;
}

// ---------------------------------------------------------------------------
// Unsubscribe
// ---------------------------------------------------------------------------

// GET — somebody clicked the link in the footer.
//
// IT UNSUBSCRIBES IMMEDIATELY rather than showing a "are you sure?" button.
// A confirmation step is one more thing to fail, and somebody who clicked
// "unsubscribe" has already said what they want. Re-subscribing is offered
// afterwards, which is the safe direction to make people click twice for.
router.get('/unsubscribe/:token', async (req, res) => {
  try {
    const send = await marketing.sendForToken(req.params.token);
    if (!send) {
      return res.status(404).send(page('Link not recognised',
        '<h1>That link is not one of ours</h1>'
        + '<p>It may have been cut short by an email client. You can manage your '
        + `preferences at <a href="${SITE_URL}/?p=preferences">unplugnews.com</a>, `
        + 'or reply to any of our emails and a person will do it for you.</p>'));
    }

    await marketing.unsubscribe({ email: send.email, all: true, reason: 'link' });
    await pool.query(
      `INSERT INTO email_events (send_id, kind) VALUES ($1, 'unsubscribe')`, [send.id]);

    res.send(page('Unsubscribed',
      '<h1>Done — you will not hear from us again</h1>'
      + `<p>We have stopped all marketing email to <strong>${escapeHtml(send.email)}</strong>. `
      + 'It takes effect immediately.</p>'
      + '<p class="muted">You will still receive anything you actually need — a receipt, '
      + 'a password reset, a download link you asked for. Those are not marketing and '
      + 'are not affected.</p>'
      + `<p><a href="${SITE_URL}/?p=preferences&e=${encodeURIComponent(send.email)}">`
      + 'Changed your mind, or want only some of it?</a></p>'));
  } catch (err) {
    console.error('[email] unsubscribe failed:', err.message);
    // Even the error page has to give somebody a way out, or the failure mode
    // is "I tried to unsubscribe and it broke", which becomes a spam report.
    res.status(500).send(page('Something went wrong',
      '<h1>That did not work</h1>'
      + '<p>Reply to any of our emails with the word "unsubscribe" and a person '
      + 'will take you off the list.</p>'));
  }
});

// POST — the one-click button in Gmail and Apple Mail (RFC 8058).
//
// Those clients POST here without the reader ever seeing a page, which is why
// it must not require a confirmation, a session or a CSRF token.
router.post('/unsubscribe/:token', express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const send = await marketing.sendForToken(req.params.token);
    if (send) {
      await marketing.unsubscribe({ email: send.email, all: true, reason: 'one-click' });
      await pool.query(`INSERT INTO email_events (send_id, kind) VALUES ($1, 'unsubscribe')`, [send.id]);
    }
    // 200 regardless. The mail client only needs to know the request arrived,
    // and an error here would have it show the reader a failure for something
    // that is our problem, not theirs.
    res.status(200).end();
  } catch (err) {
    console.error('[email] one-click unsubscribe failed:', err.message);
    res.status(200).end();
  }
});

// ---------------------------------------------------------------------------
// Preferences — the alternative to all-or-nothing
// ---------------------------------------------------------------------------

router.get('/preferences', async (req, res, next) => {
  try {
    const email = marketing.normalise(req.query.email);
    if (!email) return res.status(400).json({ error: 'An email address is required.' });

    const lists = await pool.query(
      `SELECT l.id, l.name, l.slug, l.description,
              COALESCE(s.status, 'unsubscribed') AS status
         FROM email_lists l
         LEFT JOIN email_subscriptions s
           ON s.list_id = l.id AND LOWER(s.email) = $1
        WHERE l.public = true
        ORDER BY l.name`, [email]);

    const suppressed = await marketing.isSuppressed(email);
    res.json({ email, lists: lists.rows, suppressed });
  } catch (err) { next(err); }
});

router.post('/preferences', async (req, res, next) => {
  try {
    const email = marketing.normalise(req.body.email);
    if (!email.includes('@')) return res.status(400).json({ error: 'An email address is required.' });
    const wanted = Array.isArray(req.body.lists) ? req.body.lists : [];

    const all = await pool.query('SELECT slug FROM email_lists WHERE public = true');
    for (const row of all.rows) {
      if (wanted.includes(row.slug)) {
        await marketing.subscribe({
          email, listSlug: row.slug,
          source: 'preference centre',
          ip: require('../middleware/requestContext').current().ip,
        });
      } else {
        await marketing.unsubscribe({ email, listSlug: row.slug, reason: 'preferences' });
      }
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Tracking
// ---------------------------------------------------------------------------

// A 1x1 gif. Always returned, even when nothing is recorded — a broken image
// in somebody's newsletter is a worse outcome than a missed statistic.
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

router.get('/o/:token.gif', async (req, res) => {
  try {
    const token = String(req.params.token || '').replace(/\.gif$/, '');
    const send = await marketing.sendForToken(token);
    if (send) {
      // One open per send. Mail clients re-fetch images constantly — on
      // scroll, on reopen, on prefetch — and counting each would turn one
      // reader into forty and make the whole number meaningless.
      await pool.query(
        `INSERT INTO email_events (send_id, kind)
         SELECT $1, 'open'
          WHERE NOT EXISTS (SELECT 1 FROM email_events WHERE send_id = $1 AND kind = 'open')`,
        [send.id]);
    }
  } catch (err) {
    console.error('[email] open tracking failed:', err.message);
  }
  res.set('Content-Type', 'image/gif');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.send(PIXEL);
});

router.get('/c/:token', async (req, res) => {
  const destination = String(req.query.u || '');
  try {
    // ONLY http(s), and only after parsing. A redirect endpoint that forwards
    // anywhere is an open redirect: somebody sends a link on our domain that
    // lands on theirs, and our reputation carries their phishing page.
    const url = new URL(destination);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('not a web address');

    const send = await marketing.sendForToken(req.params.token);
    if (send) {
      await pool.query(
        `INSERT INTO email_events (send_id, kind, url) VALUES ($1, 'click', $2)`,
        [send.id, destination.slice(0, 500)]);
    }
    res.redirect(302, url.toString());
  } catch (err) {
    // A bad or missing destination goes to the site rather than nowhere.
    res.redirect(302, SITE_URL);
  }
});

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = router;
