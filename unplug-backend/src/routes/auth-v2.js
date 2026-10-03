const express = require('express');
const { recordConversionAsync } = require('../utils/analyticsRecorder');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('../db');
const { notifyAdminAsync, NOTIFY } = require('../utils/adminNotify');
const { requireAuth } = require('../middleware/auth');
const { sendEmail } = require('../utils/email');
const { loginLimiter, registerLimiter, emailActionLimiter } = require('../middleware/rateLimit');
const loginAttempts = require('../utils/loginAttempts');
const twoFactor = require('../utils/twoFactor');
const { recordSignupReferral } = require('../utils/referralAttribution');

const router = express.Router();
const VALID_ROLES = ['member', 'investor', 'advertiser'];
const SITE_URL = (process.env.SITE_URL || 'https://www.unplugnews.com').replace(/\/$/, '');

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email));
}

function isValidPhone(phone) {
  const raw = String(phone || '').trim();
  if (!raw) return false;
  if (!/^[0-9+()\-.\s]+$/.test(raw)) return false;
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 9 && digits.length <= 15;
}

function phoneCandidates(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  const out = new Set();
  if (digits) out.add(digits);
  if (/^0\d{9}$/.test(digits)) out.add(`27${digits.slice(1)}`);
  if (/^27\d{9}$/.test(digits)) out.add(`0${digits.slice(2)}`);
  return [...out];
}

function generateCode() {
  return String(crypto.randomInt(100000, 1000000));
}

async function sendVerificationCode(user, destination) {
  await pool.query(
    `UPDATE email_verification_codes
        SET used_at = now()
      WHERE user_id = $1 AND used_at IS NULL`,
    [user.id]
  );

  const code = generateCode();
  await pool.query(
    `INSERT INTO email_verification_codes (user_id, code, expires_at)
     VALUES ($1, $2, now() + interval '15 minutes')`,
    [user.id, code]
  );

  let emailSent = true;
  try {
    await sendEmail({
      to: destination,
      subject: 'Verify your Unplug account',
      text: `Your Unplug verification code is: ${code}\n\nThis code expires in 15 minutes. If you did not request this, you can ignore this email.`,
    });
  } catch (err) {
    emailSent = false;
    console.error('[auth] verification email failed to send:', err.message);
  }
  return { code, emailSent };
}

async function sendPasswordResetCode(user, destination) {
  await pool.query(
    `UPDATE password_reset_tokens
        SET used_at = now()
      WHERE user_id = $1 AND used_at IS NULL`,
    [user.id]
  );

  let code;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    code = generateCode();
    try {
      await pool.query(
        `INSERT INTO password_reset_tokens (user_id, token, expires_at)
         VALUES ($1, $2, now() + interval '1 hour')`,
        [user.id, code]
      );
      break;
    } catch (err) {
      if (err.code === '23505' && attempt < 7) continue;
      throw err;
    }
  }

  try {
    await sendEmail({
      to: destination,
      subject: 'Reset your Unplug password',
      text: `Someone requested a password reset for your Unplug account.\n\nYour 6-digit reset code is: ${code}\n\nThis code expires in 1 hour. If you did not request this, you can ignore this email.`,
    });
  } catch (err) {
    console.error('[auth] password reset email failed to send:', err.message);
  }
}

async function findUserByLoginIdentifier(identifier) {
  const raw = String(identifier || '').trim();
  if (isValidEmail(raw)) {
    const email = normalizeEmail(raw);
    const result = await pool.query(
      `SELECT id, email, role, password_hash, email_verified, full_name, member_type,
              is_suspended, suspended_reason, two_factor_enabled,
              free_publishing_enabled, is_representative
         FROM users
        WHERE lower(email) = $1
        LIMIT 1`,
      [email]
    );
    return { user: result.rows[0] || null, attemptKey: email };
  }

  if (isValidPhone(raw)) {
    const candidates = phoneCandidates(raw);
    const result = await pool.query(
      `SELECT id, email, role, password_hash, email_verified, full_name, member_type,
              is_suspended, suspended_reason, two_factor_enabled,
              free_publishing_enabled, is_representative
         FROM users
        WHERE regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g') = ANY($1::text[])
        ORDER BY id ASC
        LIMIT 1`,
      [candidates]
    );
    return { user: result.rows[0] || null, attemptKey: `phone:${candidates[0] || raw}` };
  }

  return { user: null, attemptKey: raw.toLowerCase() };
}

router.post('/register', registerLimiter, async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body.email);
    const { password, phone, role, fullName, memberType } = req.body;
    const altEmail = req.body.altEmail ? normalizeEmail(req.body.altEmail) : null;

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    if (!password || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }
    if (!isValidPhone(phone)) {
      return res.status(400).json({ error: 'Please enter a valid cell number.' });
    }
    if (altEmail && !isValidEmail(altEmail)) {
      return res.status(400).json({ error: 'The alternative email address is not valid.' });
    }

    const existingResult = await pool.query(
      `SELECT id, email, email_verified, role, created_at
         FROM users
        WHERE lower(email) = $1
        LIMIT 1`,
      [email]
    );

    if (existingResult.rows.length > 0) {
      const existing = existingResult.rows[0];
      if (existing.email_verified) {
        return res.status(409).json({
          error: 'This email already has an Unplug account. Please sign in, or use Forgot Password if you cannot remember your password.',
          accountExists: true,
        });
      }

      const { emailSent } = await sendVerificationCode(existing, existing.email);
      return res.status(200).json({
        user: { id: existing.id, email: existing.email, role: existing.role, created_at: existing.created_at },
        emailSent,
        existingUnverified: true,
        needsVerification: true,
        message: emailSent
          ? 'Your account already exists but still needs verification. We sent you a fresh 6-digit verification code.'
          : 'Your account already exists but still needs verification. We could not send the email just now; use Resend Code in a moment.',
      });
    }

    const finalRole = VALID_ROLES.includes(role) ? role : 'member';
    const finalMemberType = ['individual', 'business'].includes(memberType) ? memberType : null;
    const finalName = String(fullName || '').trim().slice(0, 160) || null;
    const passwordHash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO users (email, phone, alt_email, password_hash, role, full_name, member_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, email, role, created_at`,
      [email, String(phone).trim(), altEmail, passwordHash, finalRole, finalName, finalMemberType]
    );
    const user = result.rows[0];

    notifyAdminAsync({
      type: NOTIFY.MEMBER_JOINED,
      message: `New member: ${finalName || 'someone'}`,
      detail: finalMemberType ? `Signed up as ${finalMemberType}` : null,
      link: 'users',
    });

    const { emailSent } = await sendVerificationCode(user, user.email);

    recordConversionAsync({ userId: user.id, eventName: 'signup', entityType: 'user', entityId: user.id });

    try {
      await recordSignupReferral({
        userId: user.id,
        referralCode: req.body.referralCode,
        referralClickId: req.body.referralClickId,
      });
    } catch (err) {
      console.error('[auth] signup referral attribution failed:', err.message);
    }

    return res.status(201).json({
      user,
      emailSent,
      needsVerification: true,
      message: emailSent
        ? 'Account created. Check your email for the 6-digit verification code.'
        : 'Account created, but we could not send your verification email just now. Use Resend Code in a moment.',
    });
  } catch (err) {
    next(err);
  }
});

router.post('/verify-email', emailActionLimiter, async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body.email);
    const code = String(req.body.code || '').trim();
    if (!isValidEmail(email) || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: 'Enter your email and the 6-digit verification code.' });
    }

    const userResult = await pool.query(
      'SELECT id, email, email_verified FROM users WHERE lower(email) = $1 LIMIT 1',
      [email]
    );
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'No account was found for that email address.' });
    }
    const user = userResult.rows[0];
    if (user.email_verified) {
      return res.json({ message: 'Your email is already verified. You can sign in.' });
    }

    const codeResult = await pool.query(
      `SELECT id
         FROM email_verification_codes
        WHERE user_id = $1
          AND code = $2
          AND used_at IS NULL
          AND expires_at > now()
        ORDER BY created_at DESC
        LIMIT 1`,
      [user.id, code]
    );
    if (codeResult.rows.length === 0) {
      return res.status(400).json({ error: 'That 6-digit code is incorrect or has expired. Use Resend Code for a new one.' });
    }

    await pool.query('UPDATE email_verification_codes SET used_at = now() WHERE id = $1', [codeResult.rows[0].id]);
    await pool.query('UPDATE users SET email_verified = true WHERE id = $1', [user.id]);
    return res.json({ message: 'Email verified — you can now sign in.' });
  } catch (err) {
    next(err);
  }
});

router.post('/resend-verification', emailActionLimiter, async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body.email);
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    const userResult = await pool.query(
      'SELECT id, email, email_verified FROM users WHERE lower(email) = $1 LIMIT 1',
      [email]
    );
    if (userResult.rows.length > 0 && !userResult.rows[0].email_verified) {
      await sendVerificationCode(userResult.rows[0], userResult.rows[0].email);
    }

    return res.json({ message: 'If that account still needs verification, a fresh 6-digit code has been sent.' });
  } catch (err) {
    next(err);
  }
});

router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const identifier = String(req.body.email || req.body.identifier || '').trim();
    const password = req.body.password;
    if (!identifier || !password) {
      return res.status(400).json({ error: 'Email or cell number and password are required.' });
    }

    const found = await findUserByLoginIdentifier(identifier);
    const gate = await loginAttempts.check(found.attemptKey);
    if (!gate.allowed) {
      res.set('Retry-After', String(gate.retryAfterSeconds));
      return res.status(429).json({
        error: `Too many failed sign-in attempts. Please wait ${gate.retryAfterSeconds} second${gate.retryAfterSeconds === 1 ? '' : 's'} and try again, or reset your password.`,
        retryAfterSeconds: gate.retryAfterSeconds,
      });
    }

    const user = found.user;
    if (!user) {
      await loginAttempts.recordFailure(found.attemptKey, req.ip);
      return res.status(401).json({ error: 'Invalid email/cell number or password.' });
    }

    const matches = await bcrypt.compare(password, user.password_hash || '');
    if (!matches) {
      await loginAttempts.recordFailure(found.attemptKey, req.ip);
      return res.status(401).json({ error: 'Invalid email/cell number or password.' });
    }

    if (!user.email_verified) {
      return res.status(403).json({
        error: 'Your account still needs email verification. Choose Become a Member and enter the same email address — we will send you a fresh 6-digit verification code instead of creating a duplicate account.',
        needsVerification: true,
        email: user.email,
      });
    }

    if (user.is_suspended) {
      return res.status(403).json({
        error: user.suspended_reason
          ? `Your account has been suspended: ${user.suspended_reason}`
          : 'Your account has been suspended. Contact Unplug support for details.',
      });
    }

    if (user.two_factor_enabled) {
      const code = req.body.twoFactorCode;
      if (!code) {
        return res.status(401).json({
          error: 'Enter the six-digit code from your authenticator app.',
          twoFactorRequired: true,
        });
      }
      const second = await twoFactor.verifySecondFactor(user.id, code);
      if (!second.ok) {
        await loginAttempts.recordFailure(found.attemptKey, req.ip);
        return res.status(401).json({
          error: second.replayed
            ? 'That code has already been used. Wait for your app to show the next one.'
            : 'That code is not right.',
          twoFactorRequired: true,
        });
      }
      if (second.usedRecoveryCode) {
        console.warn(`[auth] recovery code used by ${user.email}, ${second.remainingRecoveryCodes} left`);
      }
    }

    loginAttempts.recordSuccess(found.attemptKey)
      .catch((err) => console.error('[login] could not clear attempt record:', err.message));

    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: user.role,
        free_publishing_enabled: user.free_publishing_enabled,
        is_representative: user.is_representative,
      },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.json({
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        full_name: user.full_name,
        member_type: user.member_type,
        is_representative: user.is_representative,
      },
      token,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/magic-link/request', emailActionLimiter, async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body.email);
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    const userResult = await pool.query(
      'SELECT id, email, email_verified FROM users WHERE lower(email) = $1 LIMIT 1',
      [email]
    );
    if (userResult.rows.length > 0) {
      const user = userResult.rows[0];
      if (user.email_verified) {
        const recent = await pool.query(
          `SELECT COUNT(*)::int AS n
             FROM magic_link_tokens
            WHERE user_id = $1
              AND created_at > now() - interval '15 minutes'`,
          [user.id]
        );
        if (recent.rows[0].n < 5) {
          const token = crypto.randomBytes(32).toString('hex');
          await pool.query(
            `INSERT INTO magic_link_tokens (user_id, token, expires_at)
             VALUES ($1, $2, now() + interval '15 minutes')`,
            [user.id, token]
          );
          const link = `${SITE_URL}/unplug-member-dashboard.html?magic=${token}`;
          try {
            await sendEmail({
              to: user.email,
              subject: 'Your Unplug sign-in link',
              text: `Here is your sign-in link for Unplug:\n\n${link}\n\nIt works once and expires in 15 minutes.\n\nIf you did not ask to sign in, you can ignore this email.`,
            });
          } catch (err) {
            console.error('[auth] magic link email failed to send:', err.message);
          }
        }
      }
    }

    return res.json({ message: 'If that account exists, a sign-in link is on its way. Check your email.' });
  } catch (err) {
    next(err);
  }
});

router.post('/magic-link/consume', async (req, res, next) => {
  try {
    const token = String(req.body.token || '');
    if (!token) {
      return res.status(400).json({ error: 'That sign-in link is not valid.' });
    }

    const claimed = await pool.query(
      `UPDATE magic_link_tokens
          SET used_at = now()
        WHERE token = $1
          AND used_at IS NULL
          AND expires_at > now()
        RETURNING user_id`,
      [token]
    );
    if (claimed.rowCount === 0) {
      return res.status(400).json({ error: 'That sign-in link has already been used or has expired. Please request a new one.' });
    }

    const userResult = await pool.query(
      `SELECT id, email, role, full_name, member_type, is_suspended, suspended_reason,
              free_publishing_enabled, is_representative
         FROM users
        WHERE id = $1`,
      [claimed.rows[0].user_id]
    );
    if (userResult.rows.length === 0) {
      return res.status(400).json({ error: 'That account no longer exists.' });
    }

    const user = userResult.rows[0];
    if (user.is_suspended) {
      return res.status(403).json({
        error: user.suspended_reason
          ? `Your account has been suspended: ${user.suspended_reason}`
          : 'Your account has been suspended. Contact Unplug support for details.',
      });
    }

    const authToken = jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: user.role,
        free_publishing_enabled: user.free_publishing_enabled,
        is_representative: user.is_representative,
      },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.json({
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        full_name: user.full_name,
        member_type: user.member_type,
        is_representative: user.is_representative,
      },
      token: authToken,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/forgot-password', emailActionLimiter, async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body.email);
    const useAltEmail = Boolean(req.body.useAltEmail);
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    const userResult = await pool.query(
      'SELECT id, email, alt_email FROM users WHERE lower(email) = $1 LIMIT 1',
      [email]
    );
    if (userResult.rows.length > 0) {
      const user = userResult.rows[0];
      const destination = useAltEmail && user.alt_email ? user.alt_email : user.email;
      await sendPasswordResetCode(user, destination);
    }

    return res.json({ message: 'If that account exists, a 6-digit reset code has been sent. It expires in 1 hour.' });
  } catch (err) {
    next(err);
  }
});

router.post('/reset-password', emailActionLimiter, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const submitted = String(req.body.code || req.body.token || '').trim();
    const newPassword = req.body.newPassword;
    const email = normalizeEmail(req.body.email);

    if (!submitted || !newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: 'Enter the reset code and a new password of at least 8 characters.' });
    }

    const isSixDigitCode = /^\d{6}$/.test(submitted);
    if (isSixDigitCode && !isValidEmail(email)) {
      return res.status(400).json({ error: 'Enter the email address that requested this 6-digit reset code.' });
    }

    await client.query('BEGIN');
    let tokenResult;
    if (isSixDigitCode) {
      tokenResult = await client.query(
        `SELECT prt.id, prt.user_id, u.email
           FROM password_reset_tokens prt
           JOIN users u ON u.id = prt.user_id
          WHERE prt.token = $1
            AND lower(u.email) = $2
            AND prt.used_at IS NULL
            AND prt.expires_at > now()
          ORDER BY prt.created_at DESC
          LIMIT 1
          FOR UPDATE OF prt`,
        [submitted, email]
      );
    } else {
      tokenResult = await client.query(
        `SELECT prt.id, prt.user_id, u.email
           FROM password_reset_tokens prt
           JOIN users u ON u.id = prt.user_id
          WHERE prt.token = $1
            AND prt.used_at IS NULL
            AND prt.expires_at > now()
          ORDER BY prt.created_at DESC
          LIMIT 1
          FOR UPDATE OF prt`,
        [submitted]
      );
    }

    if (tokenResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'That reset code is incorrect, expired, or has already been used.' });
    }

    const resetRow = tokenResult.rows[0];
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, resetRow.user_id]);
    await client.query(
      'UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL',
      [resetRow.user_id]
    );
    await client.query('COMMIT');

    loginAttempts.recordSuccess(normalizeEmail(resetRow.email))
      .catch((err) => console.error('[reset-password] could not clear attempt record:', err.message));

    return res.json({ message: 'Password updated — you can now sign in with your new password.' });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    next(err);
  } finally {
    client.release();
  }
});

router.post('/logout', (req, res) => {
  res.json({ message: 'Logged out. Discard the token on the client.' });
});

router.post('/change-password', requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    }

    const userResult = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Account not found.' });
    }

    const ok = await bcrypt.compare(currentPassword || '', userResult.rows[0].password_hash || '');
    if (!ok) {
      return res.status(400).json({ error: 'Your current password is incorrect.' });
    }

    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);
    return res.json({ message: 'Password changed.' });
  } catch (err) {
    next(err);
  }
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT id, email, phone, role, created_at, full_name, member_type, is_representative FROM users WHERE id = $1',
      [req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }
    return res.json({ user: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.isValidPhone = isValidPhone;
module.exports.isValidEmail = isValidEmail;
module.exports.normalizeEmail = normalizeEmail;
module.exports.generateCode = generateCode;
