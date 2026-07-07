const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const { sendEmail } = require('../utils/email');
const { loginLimiter, registerLimiter, emailActionLimiter } = require('../middleware/rateLimit');

const router = express.Router();

const VALID_ROLES = ['member', 'investor', 'advertiser']; // admin is never self-registered

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6 digits
}

// POST /auth/register
// Public — creates a new member/investor/advertiser account. The account
// is created but NOT usable to log in yet — this is the "two-step
// verification at signup" requested: a 6-digit code is emailed, and
// POST /auth/verify-email must confirm it before login works.
router.post('/register', registerLimiter, async (req, res, next) => {
  try {
    const { email, password, phone, altEmail, role } = req.body;

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'A valid email is required.' });
    }
    if (!password || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }
    const finalRole = VALID_ROLES.includes(role) ? role : 'member';

    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'An account with that email already exists.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (email, phone, alt_email, password_hash, role)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, email, role, created_at`,
      [email, phone || null, altEmail || null, passwordHash, finalRole]
    );
    const user = result.rows[0];

    const code = generateCode();
    await pool.query(
      `INSERT INTO email_verification_codes (user_id, code, expires_at)
       VALUES ($1, $2, now() + interval '15 minutes')`,
      [user.id, code]
    );
    await sendEmail({
      to: email,
      subject: 'Verify your Unplug account',
      text: `Welcome to Unplug! Your verification code is: ${code}\n\nThis code expires in 15 minutes.`,
    });

    res.status(201).json({
      user,
      message: 'Account created. Check your email for a 6-digit verification code, then call POST /auth/verify-email to activate your account.',
    });
  } catch (err) {
    next(err);
  }
});

// POST /auth/verify-email
// Public — confirms the 6-digit code sent at registration. Required
// before login works.
router.post('/verify-email', emailActionLimiter, async (req, res, next) => {
  try {
    const { email, code } = req.body;
    if (!isValidEmail(email) || !code) {
      return res.status(400).json({ error: 'Email and code are required.' });
    }

    const userResult = await pool.query('SELECT id, email_verified FROM users WHERE email = $1', [email]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'No account found for that email.' });
    }
    const user = userResult.rows[0];
    if (user.email_verified) {
      return res.status(400).json({ error: 'This account is already verified.' });
    }

    const codeResult = await pool.query(
      `SELECT * FROM email_verification_codes
       WHERE user_id = $1 AND code = $2 AND used_at IS NULL AND expires_at > now()
       ORDER BY created_at DESC LIMIT 1`,
      [user.id, code]
    );
    if (codeResult.rows.length === 0) {
      return res.status(400).json({ error: 'That code is invalid or has expired.' });
    }

    await pool.query('UPDATE email_verification_codes SET used_at = now() WHERE id = $1', [codeResult.rows[0].id]);
    await pool.query('UPDATE users SET email_verified = true WHERE id = $1', [user.id]);

    res.json({ message: 'Email verified — you can now log in.' });
  } catch (err) {
    next(err);
  }
});

// POST /auth/resend-verification — in case the original code expired or
// was never received.
router.post('/resend-verification', emailActionLimiter, async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'A valid email is required.' });
    }
    const userResult = await pool.query('SELECT id, email_verified FROM users WHERE email = $1', [email]);
    // Same response whether or not the account exists, to avoid confirming
    // which emails are registered.
    if (userResult.rows.length > 0 && !userResult.rows[0].email_verified) {
      const code = generateCode();
      await pool.query(
        `INSERT INTO email_verification_codes (user_id, code, expires_at)
         VALUES ($1, $2, now() + interval '15 minutes')`,
        [userResult.rows[0].id, code]
      );
      await sendEmail({ to: email, subject: 'Your new Unplug verification code', text: `Your verification code is: ${code}\n\nThis code expires in 15 minutes.` });
    }
    res.json({ message: 'If that account needs verifying, a new code has been sent.' });
  } catch (err) {
    next(err);
  }
});

// POST /auth/login
// Public — verifies credentials and returns a JWT. Blocked until the
// account's email is verified (see /auth/verify-email above).
router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!isValidEmail(email) || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const result = await pool.query(
      'SELECT id, email, role, password_hash, email_verified FROM users WHERE email = $1',
      [email]
    );
    const user = result.rows[0];

    // Same generic error whether the email doesn't exist or the password is
    // wrong — avoids revealing which accounts exist.
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    const matches = await bcrypt.compare(password, user.password_hash);
    if (!matches) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    if (!user.email_verified) {
      return res.status(403).json({ error: 'Please verify your email before logging in. Check your inbox for a code, or call POST /auth/resend-verification.' });
    }

    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, {
      expiresIn: '7d',
    });

    res.json({
      user: { id: user.id, email: user.email, role: user.role },
      token,
    });
  } catch (err) {
    next(err);
  }
});

// POST /auth/forgot-password
// Public — sends a reset link/token to the account's primary email OR
// alternative email, whichever the requester specifies via `useAltEmail`.
// Always returns the same generic message, whether or not the account
// exists, so this can't be used to enumerate registered emails.
router.post('/forgot-password', emailActionLimiter, async (req, res, next) => {
  try {
    const { email, useAltEmail } = req.body;
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'A valid email is required.' });
    }

    const userResult = await pool.query('SELECT id, email, alt_email FROM users WHERE email = $1', [email]);
    if (userResult.rows.length > 0) {
      const user = userResult.rows[0];
      const destination = useAltEmail && user.alt_email ? user.alt_email : user.email;

      const token = crypto.randomBytes(32).toString('hex');
      await pool.query(
        `INSERT INTO password_reset_tokens (user_id, token, expires_at)
         VALUES ($1, $2, now() + interval '1 hour')`,
        [user.id, token]
      );
      await sendEmail({
        to: destination,
        subject: 'Reset your Unplug password',
        text: `Someone requested a password reset for your Unplug account.\n\nYour reset code is: ${token}\n\nThis expires in 1 hour. If you didn't request this, you can ignore this email.`,
      });
    }

    res.json({ message: 'If that account exists, a reset link has been sent.' });
  } catch (err) {
    next(err);
  }
});

// POST /auth/reset-password
// Public — completes a reset using the token emailed above.
router.post('/reset-password', async (req, res, next) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: 'token and a newPassword of at least 8 characters are required.' });
    }

    const tokenResult = await pool.query(
      `SELECT * FROM password_reset_tokens WHERE token = $1 AND used_at IS NULL AND expires_at > now()`,
      [token]
    );
    if (tokenResult.rows.length === 0) {
      return res.status(400).json({ error: 'That reset link is invalid or has expired.' });
    }
    const resetRow = tokenResult.rows[0];

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, resetRow.user_id]);
    await pool.query('UPDATE password_reset_tokens SET used_at = now() WHERE id = $1', [resetRow.id]);

    res.json({ message: 'Password updated — you can now log in with your new password.' });
  } catch (err) {
    next(err);
  }
});

// POST /auth/logout
// JWTs are stateless, so there's nothing to invalidate server-side in this
// simple setup — the frontend just discards the token. This endpoint exists
// so the API surface matches the spec and leaves room for a token-blocklist
// later if that becomes necessary.
router.post('/logout', (req, res) => {
  res.json({ message: 'Logged out. Discard the token on the client.' });
});

// GET /auth/me
// Returns the currently authenticated user, based on the bearer token.
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT id, email, phone, role, created_at FROM users WHERE id = $1',
      [req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }
    res.json({ user: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
