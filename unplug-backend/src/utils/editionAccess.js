// Reference codes and download tokens for paid edition downloads.
//
// These two strings are the whole access-control story for a download, so both
// are generated with crypto.randomInt / randomBytes rather than Math.random —
// Math.random is predictable from previous outputs, which for a code that
// unlocks paid content means guessable.
const crypto = require('crypto');
const pool = require('../db');

// Reference codes get read off a screen, written on a bank transfer, and typed
// back in. O/0 and I/1 are indistinguishable in many fonts, so they're out —
// a customer mistyping their own reference is a support problem, and the code
// is still 10 characters from a 32-symbol alphabet (~2^50 combinations).
const REFERENCE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const REFERENCE_LENGTH = 10;

function randomReference() {
  let out = '';
  for (let i = 0; i < REFERENCE_LENGTH; i++) {
    out += REFERENCE_ALPHABET[crypto.randomInt(REFERENCE_ALPHABET.length)];
  }
  return out;
}

// A unique reference. The database has a unique index on the column, so this
// re-rolls on the (vanishingly unlikely) collision rather than assuming
// randomness is enough — the constraint is the real guarantee, this is just
// how we avoid handing the customer an error.
async function generateReference(client = pool) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = randomReference();
    const existing = await client.query(
      'SELECT 1 FROM edition_purchases WHERE download_reference = $1', [candidate]
    );
    if (existing.rowCount === 0) return candidate;
  }
  throw new Error('Could not generate a unique reference code.');
}

// The download token. 32 random bytes — not derived from the purchase id, the
// email or the edition, because anything derived from known values can be
// reconstructed by someone who knows them.
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Constant-time compare for the reference a customer submits. Guards against
// an attacker learning a valid code character-by-character from response
// timing. Cheap to do, and this is the one string standing between a stranger
// and paid content.
function referenceMatches(submitted, actual) {
  if (!submitted || !actual) return false;
  const a = Buffer.from(String(submitted).trim().toUpperCase());
  const b = Buffer.from(String(actual).trim().toUpperCase());
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function normaliseEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normaliseEmail(email));
}

module.exports = {
  generateReference, generateToken, referenceMatches,
  normaliseEmail, isValidEmail,
  REFERENCE_ALPHABET, REFERENCE_LENGTH,
};
