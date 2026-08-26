// Two-factor authentication for admins: TOTP, plus recovery codes.
//
// TOTP is the six-digit code from an authenticator app. It is derived from a
// shared secret and the current time, so it works with no network, no SMS and
// no third party — which matters here, because SMS costs money per message and
// is the weakest of the common second factors anyway.
//
// THE THINGS THAT MAKE THIS SAFE RATHER THAN DECORATIVE:
//
//   - Enrolment is not finished until a code has been proved. A secret stored
//     but never confirmed leaves an admin locked out at their next sign-in.
//   - A code cannot be replayed. TOTP codes last thirty seconds, so one seen
//     over somebody's shoulder or captured in a log is usable until it
//     expires. The last accepted code is remembered and refused a second time.
//   - Recovery codes are hashed. They are passwords by another name; storing
//     them in plain text means one read of the table is every admin's way in.
//   - Verification is constant-time where it compares secrets.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const otplib = require('otplib');
const pool = require('../db');

const ISSUER = 'Unplug Magazine';

// How many thirty-second steps either side of now are accepted. One step is
// the usual answer: it forgives a phone clock a few seconds out and somebody
// typing slowly, without widening the window a stolen code stays usable in.
const WINDOW = 1;

const RECOVERY_CODE_COUNT = 8;

// Begins enrolment. Returns the secret and the otpauth:// URI a QR code is
// made from. Nothing is switched on yet.
async function beginEnrolment(userId, email) {
  const secret = await otplib.generateSecret();
  const uri = await otplib.generateURI({ secret, label: email, issuer: ISSUER });

  // Stored now so the confirmation step has something to check against, but
  // two_factor_enabled stays false. An abandoned enrolment leaves a secret
  // nobody uses, which is harmless; the reverse — enabling first — locks
  // somebody out.
  await pool.query(
    `UPDATE users SET two_factor_secret = $1, two_factor_enabled = false,
                      two_factor_confirmed_at = NULL
      WHERE id = $2`, [secret, userId]);

  return { secret, uri };
}

// Checks a code against a secret. Returns true/false, never throws.
async function checkToken(secret, token) {
  if (!secret || !/^\d{6}$/.test(String(token || '').trim())) return false;
  try {
    const result = await otplib.verify({ secret, token: String(token).trim(), window: WINDOW });
    return Boolean(result && result.valid);
  } catch (err) {
    return false;
  }
}

// Finishes enrolment: only now does the second factor actually apply.
// Returns the recovery codes, which are shown once and never again.
async function confirmEnrolment(userId, token) {
  const r = await pool.query('SELECT two_factor_secret FROM users WHERE id = $1', [userId]);
  const secret = r.rows[0] && r.rows[0].two_factor_secret;
  if (!secret) return { ok: false, error: 'Start setting up two-factor authentication first.' };

  if (!await checkToken(secret, token)) {
    return { ok: false, error: 'That code is not right. Check your authenticator app and try the current code.' };
  }

  const codes = await regenerateRecoveryCodes(userId);
  await pool.query(
    `UPDATE users SET two_factor_enabled = true, two_factor_confirmed_at = now(),
                      two_factor_last_token = $2
      WHERE id = $1`, [userId, String(token).trim()]);

  return { ok: true, recoveryCodes: codes };
}

// Human-readable, unambiguous codes: no letters that can be misread as digits
// when somebody writes one on paper, which is exactly what people do with
// these.
function newRecoveryCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I, L, O, 0, 1
  const bytes = crypto.randomBytes(10);
  let out = '';
  for (let i = 0; i < 10; i++) {
    out += alphabet[bytes[i] % alphabet.length];
    if (i === 4) out += '-';
  }
  return out;
}

async function regenerateRecoveryCodes(userId) {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  // Replaces any previous set. Codes issued before this moment stop working,
  // which is the point of regenerating them.
  await pool.query('DELETE FROM two_factor_recovery_codes WHERE user_id = $1', [userId]);
  for (const code of codes) {
    await pool.query(
      'INSERT INTO two_factor_recovery_codes (user_id, code_hash) VALUES ($1, $2)',
      [userId, bcrypt.hashSync(code, 10)]);
  }
  return codes;
}

// Verifies a second factor at sign-in: a TOTP code, or a recovery code.
//
// Returns { ok, usedRecoveryCode, remainingRecoveryCodes }.
async function verifySecondFactor(userId, submitted) {
  const value = String(submitted || '').trim();
  if (!value) return { ok: false };

  const r = await pool.query(
    'SELECT two_factor_secret, two_factor_last_token FROM users WHERE id = $1', [userId]);
  if (r.rowCount === 0) return { ok: false };
  const { two_factor_secret: secret, two_factor_last_token: lastToken } = r.rows[0];

  // --- a six-digit TOTP code ----------------------------------------------
  if (/^\d{6}$/.test(value)) {
    // REPLAY. A code is valid for thirty seconds, so one glimpsed or logged is
    // usable until it expires. Refusing the code that was last accepted closes
    // that window for this account.
    // A plain comparison, deliberately. timingSafeEqual guards against an
    // attacker learning a secret from how long a comparison takes; the value
    // being compared here is a code they just sent us and already know.
    // It also throws on a length mismatch, which would turn a stray row into
    // a 500 at sign-in.
    if (lastToken && String(lastToken) === value) {
      return { ok: false, replayed: true };
    }
    if (await checkToken(secret, value)) {
      await pool.query('UPDATE users SET two_factor_last_token = $2 WHERE id = $1', [userId, value]);
      return { ok: true, usedRecoveryCode: false };
    }
    return { ok: false };
  }

  // --- a recovery code ----------------------------------------------------
  const normalised = value.toUpperCase().replace(/\s+/g, '');
  const unused = await pool.query(
    'SELECT id, code_hash FROM two_factor_recovery_codes WHERE user_id = $1 AND used_at IS NULL',
    [userId]);

  for (const row of unused.rows) {
    if (bcrypt.compareSync(normalised, row.code_hash)) {
      // Marked used in the same statement that checks it is still unused, so
      // the same code presented twice at once cannot both succeed.
      const claim = await pool.query(
        'UPDATE two_factor_recovery_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id',
        [row.id]);
      if (claim.rowCount === 0) return { ok: false };

      const left = await pool.query(
        'SELECT count(*)::int AS n FROM two_factor_recovery_codes WHERE user_id = $1 AND used_at IS NULL',
        [userId]);
      return { ok: true, usedRecoveryCode: true, remainingRecoveryCodes: left.rows[0].n };
    }
  }
  return { ok: false };
}

async function isEnabled(userId) {
  const r = await pool.query('SELECT two_factor_enabled FROM users WHERE id = $1', [userId]);
  return r.rowCount > 0 && r.rows[0].two_factor_enabled === true;
}

// Switching it off requires proving you can still pass it. Otherwise anyone
// holding a stolen session could simply remove the protection.
async function disable(userId, submitted) {
  const check = await verifySecondFactor(userId, submitted);
  if (!check.ok) return { ok: false, error: 'That code is not right.' };
  await pool.query(
    `UPDATE users SET two_factor_enabled = false, two_factor_secret = NULL,
                      two_factor_confirmed_at = NULL, two_factor_last_token = NULL
      WHERE id = $1`, [userId]);
  await pool.query('DELETE FROM two_factor_recovery_codes WHERE user_id = $1', [userId]);
  return { ok: true };
}

module.exports = {
  beginEnrolment, confirmEnrolment, verifySecondFactor, regenerateRecoveryCodes,
  isEnabled, disable, checkToken, newRecoveryCode,
  ISSUER, WINDOW, RECOVERY_CODE_COUNT,
};
