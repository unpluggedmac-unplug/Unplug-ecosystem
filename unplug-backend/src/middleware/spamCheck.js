// Scoring a public submission on its way in.
//
// WHAT IT DOES NOT DO: block. By default nothing is refused and nothing is
// deleted. The submission goes to the moderation queue it was always going to,
// carrying a score and the reasons for it, so the queue can be sorted and a
// moderator reads the real entries first.
//
// Auto-rejection exists but is off unless an admin turns it on, and even then
// the row is kept and reviewable. On a site this size a person can read
// everything that arrives; the cost of a genuine nomination disappearing
// unseen is far higher than the cost of a moment's reading.
//
// FAILURE IS ALWAYS TOWARDS ACCEPTING. Every error path here treats the
// submission as clean. A contact form that returns 500 because the spam filter
// had a bad day is a worse outcome than a spam message in a queue.

const crypto = require('crypto');
const scorer = require('../utils/spamScorer');

// ---------------------------------------------------------------------------
// The form token
//
// Issued when a form is opened, sent back when it is submitted. It carries
// two of the strongest signals there are, and it costs a reader nothing:
//
//   1. JavaScript ran. Something that posts straight to the endpoint has no
//      token, because getting one requires making a request first.
//   2. How long the form was open. A person reads, thinks and types; two
//      seconds start to finish is not a person.
//
// Signed, so the timestamp cannot simply be invented. Stateless, so opening a
// thousand forms stores nothing.
// ---------------------------------------------------------------------------

const TOKEN_TTL_MS = 6 * 60 * 60 * 1000; // a form left open all afternoon still works

function tokenKey() {
  return process.env.ALTCHA_HMAC_KEY || process.env.JWT_SECRET || 'unplug-form-token-development-only';
}

function issueFormToken() {
  const issued = Date.now();
  const nonce = crypto.randomBytes(6).toString('hex');
  const payload = `${issued}.${nonce}`;
  const sig = crypto.createHmac('sha256', tokenKey()).update(payload).digest('hex').slice(0, 32);
  return `${payload}.${sig}`;
}

// Returns { valid, elapsedMs }. An invalid or missing token is not an error —
// it is one signal among several, worth a few points and nothing more.
function readFormToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return { valid: false, elapsedMs: null };

  const [issued, nonce, sig] = parts;
  const expected = crypto.createHmac('sha256', tokenKey())
    .update(`${issued}.${nonce}`).digest('hex').slice(0, 32);

  const a = Buffer.from(String(sig));
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { valid: false, elapsedMs: null };
  }

  const ms = Date.now() - Number(issued);
  if (!Number.isFinite(ms) || ms < 0 || ms > TOKEN_TTL_MS) {
    return { valid: false, elapsedMs: null };
  }
  return { valid: true, elapsedMs: ms };
}

// ---------------------------------------------------------------------------
// The middleware
// ---------------------------------------------------------------------------

// Everything the submission said, minus the plumbing. The token and the
// honeypot are not content and would only add noise to the classifier.
function contentFields(body) {
  const skip = new Set(['formToken', 'altcha', 'website', 'password', 'token', 'captcha']);
  const out = {};
  for (const [k, v] of Object.entries(body || {})) {
    if (skip.has(k)) continue;
    if (typeof v === 'string' || typeof v === 'number') out[k] = String(v);
  }
  // The trap is passed through separately so the honeypot signal can see it
  // without it reaching the classifier as if it were something somebody wrote.
  if (body && typeof body.website === 'string') out.website = body.website;
  return out;
}

// spamCheck('inquiry') — assesses, records, and attaches the result.
//
// The route continues in every case. It may consult req.spam to sort or mark
// what it stores, and should call req.spam.link(id) once it knows the id of
// the row it created.
function spamCheck(targetType) {
  return async function spamCheckMiddleware(req, res, next) {
    try {
      const token = readFormToken(req.body && req.body.formToken);
      const fields = contentFields(req.body);

      const submission = {
        targetType,
        fields,
        elapsedMs: token.elapsedMs,
        jsTokenValid: token.valid,
        ip: (require('./requestContext').current().ip) || null,
      };

      const assessment = await scorer.assess(submission);
      const assessmentId = await scorer.record(assessment, submission);

      req.spam = {
        ...assessment,
        assessmentId,
        // Called by the route once the submission has an id, so a moderator
        // looking at a flagged entry can find the thing itself.
        link: async (targetId) => {
          if (!assessmentId || !targetId) return;
          try {
            const pool = require('../db');
            await pool.query(
              'UPDATE spam_assessments SET target_id = $2 WHERE id = $1',
              [assessmentId, targetId]);
          } catch (err) {
            console.error('[spam] could not link assessment to submission:', err.message);
          }
        },
      };
    } catch (err) {
      // See the note at the top: every failure lands on "clean".
      console.error('[spam] check failed, treating submission as clean:', err.message);
      req.spam = { score: 0, verdict: 'clean', signals: [], shouldAutoReject: false, link: async () => {} };
    }
    next();
  };
}

module.exports = { spamCheck, issueFormToken, readFormToken, contentFields, TOKEN_TTL_MS };
