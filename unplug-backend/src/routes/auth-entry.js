const express = require('express');
const crypto = require('crypto');
const pool = require('../db');
const { sendEmail } = require('../utils/email');
const auth = require('./auth-v2');

const router = express.Router();
const normalizeEmail = auth.normalizeEmail;
const isValidEmail = auth.isValidEmail;

// A common real-world failure is: the member registers, misses the verification
// email, then tries to register again. Historically that second attempt was a
// dead end. Catch only that state here, issue a fresh code (with a short resend
// throttle), and return a structured 409 so the browser can move directly to
// the verification card without creating a duplicate account.
router.post('/register', async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body && req.body.email);
    if (!isValidEmail(email)) return next();

    const existing = await pool.query(
      `SELECT id, email, email_verified
         FROM users
        WHERE lower(email) = $1
        LIMIT 1`,
      [email]
    );
    if (!existing.rowCount || existing.rows[0].email_verified) return next();

    const user = existing.rows[0];
    const recent = await pool.query(
      `SELECT id
         FROM email_verification_codes
        WHERE user_id = $1
          AND used_at IS NULL
          AND expires_at > now()
          AND created_at > now() - interval '2 minutes'
        ORDER BY created_at DESC
        LIMIT 1`,
      [user.id]
    );

    let sent = false;
    if (!recent.rowCount) {
      await pool.query(
        `UPDATE email_verification_codes
            SET used_at = now()
          WHERE user_id = $1 AND used_at IS NULL`,
        [user.id]
      );
      const code = String(crypto.randomInt(100000, 1000000));
      await pool.query(
        `INSERT INTO email_verification_codes (user_id, code, expires_at)
         VALUES ($1, $2, now() + interval '15 minutes')`,
        [user.id, code]
      );
      try {
        await sendEmail({
          to: user.email,
          subject: 'Your new Unplug verification code',
          text: `Your new 6-digit Unplug verification code is: ${code}\n\nThis code expires in 15 minutes.`,
        });
        sent = true;
      } catch (mailErr) {
        console.error('[auth] repeated-signup verification email failed:', mailErr.message);
      }
    }

    return res.status(409).json({
      error: sent
        ? 'Your Unplug account already exists but still needs email verification. We sent a fresh 6-digit code — enter it to activate your account.'
        : 'Your Unplug account already exists but still needs email verification. Use the verification code we sent recently, or tap Resend Code.',
      needsVerification: true,
      email: user.email,
    });
  } catch (err) {
    next(err);
  }
});

// Keep the stable auth contract explicit for older clients and regression
// checks: an unverified sign-in must clearly tell the member to VERIFY their
// email. auth-v2 also returns structured recovery fields; preserve all of them
// while making the human-facing instruction unambiguous.
router.use('/login', (req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (
      res.statusCode === 403
      && body
      && body.needsVerification === true
      && typeof body.error === 'string'
      && !/verify/i.test(body.error)
    ) {
      return originalJson({
        ...body,
        error: `Please verify your email before signing in. ${body.error}`,
      });
    }
    return originalJson(body);
  };
  next();
});

router.use(auth);

module.exports = router;
module.exports.isValidPhone = auth.isValidPhone;
module.exports.isValidEmail = auth.isValidEmail;
module.exports.normalizeEmail = auth.normalizeEmail;
module.exports.generateCode = auth.generateCode;
