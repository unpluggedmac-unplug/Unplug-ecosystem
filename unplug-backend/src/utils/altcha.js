// Proof-of-work bot defence, in the Altcha format, self-hosted.
//
// HOW IT WORKS. The server picks a secret number, tells the client the HASH of
// that number and the range it lies in, and the client finds it by trying
// every value. Finding it costs a fraction of a second of CPU; checking the
// answer costs one hash. That asymmetry is the whole mechanism: a person
// submitting a form once never notices, and a script submitting ten thousand
// times pays ten thousand times over.
//
// WHY NOT reCAPTCHA. It sends every visitor's behaviour to Google, which for a
// South African community magazine means handing a third party a record of who
// reads what in exchange for spam filtering. It also makes the site depend on
// a service that can rate-limit or block it. Altcha's format needs no account,
// no key, no third party and no network call from the reader's browser to
// anywhere but this site.
//
// WHY NOT A LIBRARY. The whole protocol is two HMACs and a loop. A dependency
// in the sign-up path is a dependency that can break the sign-up path.
//
// WHAT THIS DOES AND DOES NOT STOP. It stops volume: a script firing at a form
// continuously. It does not stop somebody determined to post one nasty comment
// by hand, and it is not meant to — that is what moderation is for. It is one
// signal among several, which is how B3 will use it.

const crypto = require('crypto');

// How hard the puzzle is. The client tries numbers from zero upward, so the
// average work is half of this. 50,000 SHA-256 hashes is a few hundred
// milliseconds in a browser — unnoticeable once, expensive in bulk.
//
// Deliberately not higher. The people most affected by a heavy puzzle are
// those on old phones, which in this audience is a lot of them, and a form
// that takes six seconds to submit on a cheap Android is a form that does not
// get submitted.
const MAX_NUMBER = 50000;

// A challenge is only good for ten minutes. Long enough to fill in a long
// form, short enough that a stockpile of solved challenges goes stale.
const TTL_MS = 10 * 60 * 1000;

// Signing key. Falls back to JWT_SECRET so this works with no extra
// configuration; a dedicated key is better and the deployment notes say so.
function key() {
  return process.env.ALTCHA_HMAC_KEY || process.env.JWT_SECRET || 'unplug-altcha-development-only';
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

function sign(payload) {
  return crypto.createHmac('sha256', key()).update(String(payload)).digest('hex');
}

// Builds a challenge for the browser to solve.
function createChallenge() {
  const salt = crypto.randomBytes(12).toString('hex');
  const number = crypto.randomInt(0, MAX_NUMBER);
  const expires = Date.now() + TTL_MS;

  // The expiry travels inside the salt, so the server keeps no state at all.
  // Nothing to store, nothing to clean up, and nothing that grows if somebody
  // requests a million challenges.
  const saltWithExpiry = `${salt}.${expires}`;
  const challenge = sha256(saltWithExpiry + number);

  return {
    algorithm: 'SHA-256',
    challenge,
    salt: saltWithExpiry,
    maxnumber: MAX_NUMBER,
    // Signed so a client cannot invent its own easy challenge and solve that
    // instead. Without this the whole thing is decoration.
    signature: sign(challenge),
  };
}

// Checks a solution. Returns { ok, reason }.
//
// Every failure returns the same shape and the caller shows one message: a
// bot learning WHY its answer was rejected learns how to fix it.
function verifySolution(payload) {
  let data = payload;

  // The browser widget sends base64-encoded JSON; a direct API caller may send
  // the object. Both accepted.
  if (typeof data === 'string') {
    try {
      data = JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
    } catch (err) {
      try { data = JSON.parse(data); } catch (e) { return { ok: false, reason: 'unreadable' }; }
    }
  }
  if (!data || typeof data !== 'object') return { ok: false, reason: 'missing' };

  const { algorithm, challenge, number, salt, signature } = data;
  if (algorithm !== 'SHA-256') return { ok: false, reason: 'algorithm' };
  if (!challenge || !salt || !signature) return { ok: false, reason: 'incomplete' };
  if (!Number.isInteger(number) || number < 0 || number > MAX_NUMBER) {
    return { ok: false, reason: 'number' };
  }

  // 1. Did WE issue this challenge? Compared in constant time — this one is a
  //    real secret, and a timing leak here would let somebody forge challenges.
  const expected = sign(challenge);
  const a = Buffer.from(String(signature));
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'signature' };
  }

  // 2. Has it gone stale?
  const expires = Number(String(salt).split('.')[1]);
  if (!Number.isFinite(expires) || Date.now() > expires) {
    return { ok: false, reason: 'expired' };
  }

  // 3. Is the answer right?
  if (sha256(salt + number) !== challenge) return { ok: false, reason: 'wrong' };

  return { ok: true, reason: null };
}

// Express middleware for a form that requires a solved challenge.
//
// OFF UNLESS SWITCHED ON. Requiring proof-of-work on a form before the
// frontend sends any would reject every genuine submission, and the failure
// would look like the form being broken rather than the check being new. So
// the default is to allow, and ALTCHA_REQUIRED=1 turns it on once the widget
// is in place. B3 wires the frontend.
function required(req, res, next) {
  if (process.env.ALTCHA_REQUIRED !== '1') return next();

  const result = verifySolution(req.body && req.body.altcha);
  if (result.ok) return next();

  console.warn(`[altcha] rejected a submission: ${result.reason}`);
  res.status(400).json({
    error: 'We could not confirm this was submitted by a person. Please reload the page and try again.',
  });
}

module.exports = { createChallenge, verifySolution, required, MAX_NUMBER, TTL_MS };
