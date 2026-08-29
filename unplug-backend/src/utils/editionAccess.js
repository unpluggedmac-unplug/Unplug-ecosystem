// Reference codes and download tokens for paid edition downloads.
//
// These two strings are the whole access-control story for a download, so both
// are generated with crypto.randomInt / randomBytes rather than Math.random —
// Math.random is predictable from previous outputs, which for a code that
// unlocks paid content means guessable.
const crypto = require('crypto');
const pool = require('../db');

// The alphabet and its reasoning now live in src/utils/reference.js, so the
// same 32 characters are not written out in five files. Re-exported below
// because callers already import them from here.
const {
  REFERENCE_ALPHABET, REFERENCE_LENGTH, randomCode, generateUnique,
} = require('./reference');

const randomReference = () => randomCode(REFERENCE_LENGTH);

// A unique reference. The database has a unique index on the column, so this
// re-rolls on the (vanishingly unlikely) collision rather than assuming
// randomness is enough — the constraint is the real guarantee, this is just
// how we avoid handing the customer an error.
// No UNP- prefix here, deliberately: download_reference is VARCHAR(10), so a
// prefix does not fit without a migration of a column live rows already use.
async function generateReference(client = pool) {
  return generateUnique({
    table: 'edition_purchases', column: 'download_reference', client,
  });
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
