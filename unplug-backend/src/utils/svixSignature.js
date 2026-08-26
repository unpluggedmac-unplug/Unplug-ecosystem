// Verifying a Svix-signed webhook, which is what Resend sends.
//
// WHY THIS IS WRITTEN OUT RATHER THAN `npm install svix`: the whole library is
// a client for Svix's API, of which this project needs one function — an HMAC
// and a comparison. The same reasoning that produced a hand-written SigV4
// signer here rather than the AWS SDK. It is about forty lines and the format
// is documented and stable.
//
// WHAT THE SIGNATURE IS ACTUALLY FOR, because it is easy to treat as ceremony:
//
//   The webhook endpoint SUPPRESSES EMAIL ADDRESSES. An unsigned version of it
//   is a remote denial-of-mail — anybody who found the URL could POST
//   "bounced" for every subscriber in turn and silently kill the whole list,
//   and it would look exactly like a deliverability problem for weeks.
//
// So there is no "verify if a secret is configured" path. With no secret the
// endpoint refuses everything.
//
// The scheme (https://docs.svix.com/receiving/verifying-payloads/how):
//
//   signed content  = `${svix-id}.${svix-timestamp}.${raw body}`
//   secret          = base64-decoded, after stripping the "whsec_" prefix
//   signature       = base64( HMAC-SHA256(secret, signed content) )
//   svix-signature  = space-separated list of `v1,<signature>` — a list
//                     because secrets are rotated by sending both for a while.

const crypto = require('crypto');

// How far out of date a webhook may be. Signatures never expire on their own,
// so without this a captured request could be replayed for ever — replaying a
// "complained" event repeatedly is a way to keep an address suppressed after
// somebody has legitimately been let back on.
const TOLERANCE_SECONDS = 5 * 60;

function parseSecret(secret) {
  const raw = String(secret || '');
  if (!raw) return null;
  return Buffer.from(raw.replace(/^whsec_/, ''), 'base64');
}

// Compares in constant time. `crypto.timingSafeEqual` throws on a length
// mismatch rather than returning false, so the lengths are checked first —
// and a length mismatch is not a secret, it just means a malformed header.
function matches(expected, provided) {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Returns { ok: true } or { ok: false, reason }.
//
// `body` MUST be the raw bytes exactly as received. Parsing to JSON and
// re-serialising changes key order and whitespace, and the signature is over
// the bytes — this is the mistake that makes a correct secret look wrong.
function verify({ body, headers, secret, now = Date.now() }) {
  const key = parseSecret(secret);
  if (!key || !key.length) return { ok: false, reason: 'no signing secret is configured' };

  const id = headers['svix-id'] || headers['webhook-id'];
  const timestamp = headers['svix-timestamp'] || headers['webhook-timestamp'];
  const signature = headers['svix-signature'] || headers['webhook-signature'];
  if (!id || !timestamp || !signature) return { ok: false, reason: 'the signature headers are missing' };

  const sent = Number(timestamp);
  if (!Number.isFinite(sent)) return { ok: false, reason: 'the timestamp is not a number' };
  const drift = Math.abs(now / 1000 - sent);
  if (drift > TOLERANCE_SECONDS) {
    return { ok: false, reason: `the timestamp is ${Math.round(drift)}s out — too old to accept` };
  }

  const payload = Buffer.isBuffer(body) ? body.toString('utf8') : String(body || '');
  const expected = crypto.createHmac('sha256', key)
    .update(`${id}.${timestamp}.${payload}`)
    .digest('base64');

  // Any one of the offered signatures matching is enough. During a secret
  // rotation Svix sends the old and the new together, and rejecting because
  // the first one listed is the old one would drop every bounce for a day.
  const offered = String(signature).split(' ')
    .map((part) => part.split(',')[1])
    .filter(Boolean);

  for (const candidate of offered) {
    if (matches(expected, candidate)) return { ok: true, id };
  }
  return { ok: false, reason: 'the signature does not match' };
}

// Used by the tests, and by anybody who needs to reproduce a real request.
function sign({ body, id, timestamp, secret }) {
  const key = parseSecret(secret);
  const payload = Buffer.isBuffer(body) ? body.toString('utf8') : String(body || '');
  const digest = crypto.createHmac('sha256', key)
    .update(`${id}.${timestamp}.${payload}`)
    .digest('base64');
  return { 'svix-id': id, 'svix-timestamp': String(timestamp), 'svix-signature': `v1,${digest}` };
}

module.exports = { verify, sign, TOLERANCE_SECONDS };
