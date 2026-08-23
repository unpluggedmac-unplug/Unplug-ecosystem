// What is currently being attacked, and the controls for it.
//
// Admin-only throughout. The point of this screen is to answer two questions
// quickly when something looks wrong: is anyone working through our accounts
// right now, and can I let this particular person back in.

const express = require('express');
const { requireRole } = require('../middleware/auth');
const { logActivity } = require('./activityLog');
const loginAttempts = require('../utils/loginAttempts');
const accessControl = require('../middleware/accessControl');
const requestContext = require('../middleware/requestContext');
const { isValidIp, isValidCidr, inCidr, sameAddress } = require('../utils/ipMatch');
const pool = require('../db');
const twoFactor = require('../utils/twoFactor');
const altcha = require('../utils/altcha');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /security/login-attempts — who is failing to sign in, and how.
//
// Sorted so that spraying floats to the top. One address failing eight times
// is somebody who changed their password and has not updated their phone;
// eight addresses failing against one account is an attack, and the two need
// telling apart at a glance rather than by reading timestamps.
router.get('/login-attempts', requireRole('admin'), async (req, res, next) => {
  try {
    const rows = await loginAttempts.currentlyBlocked(100);
    res.json({
      attempts: rows,
      policy: {
        freeAttempts: loginAttempts.FREE_ATTEMPTS,
        baseDelaySeconds: loginAttempts.BASE_DELAY_SECONDS,
        maxDelaySeconds: loginAttempts.MAX_DELAY_SECONDS,
        resetAfterHours: loginAttempts.RESET_AFTER_HOURS,
        // Spelled out because the obvious reading of this screen is "these
        // people are locked out", and that is not what it means.
        note: 'Nobody is locked out. Each failure makes the next attempt wait '
            + 'longer, the wait is capped, and it clears on a correct password '
            + 'or after a day of quiet. A password reset is never blocked.',
      },
    });
  } catch (err) { next(err); }
});

// DELETE /security/login-attempts/:identifier — clear the delay for one person.
//
// For the case where somebody is on the phone saying they cannot get in. It
// removes the delay; it does not change their password or bypass anything
// else, so the worst it can do is give an attacker back the three free
// attempts they already had.
router.delete('/login-attempts/:identifier', requireRole('admin'), async (req, res, next) => {
  try {
    const identifier = String(req.params.identifier || '');
    const cleared = await loginAttempts.clear(identifier);
    if (!cleared) {
      return res.status(404).json({ error: 'There is no sign-in delay recorded for that address.' });
    }
    // Worth an audit entry: an admin removed a defence for a named account.
    logActivity(req.user.id, 'login_delay_cleared', identifier);
    res.json({ cleared: true });
  } catch (err) { next(err); }
});


// ---------------------------------------------------------------------------
// Access rules — who is kept out, and who can never be kept out
// ---------------------------------------------------------------------------

// GET /security/access-rules
router.get('/access-rules', requireRole('admin'), async (req, res, next) => {
  try {
    const rules = await pool.query(
      `SELECT r.*, u.email AS created_by_email,
              (r.expires_at IS NOT NULL AND r.expires_at <= now()) AS expired
         FROM access_rules r
         LEFT JOIN users u ON u.id = r.created_by
        ORDER BY r.effect, r.hit_count DESC, r.created_at DESC`);
    const denials = await pool.query(
      `SELECT ip_address, path, denied_by, count(*)::int AS n, max(created_at) AS last_seen
         FROM access_denials
        WHERE created_at > now() - INTERVAL '7 days'
        GROUP BY ip_address, path, denied_by
        ORDER BY n DESC LIMIT 100`);
    res.json({
      rules: rules.rows,
      recentDenials: denials.rows,
      // The address the admin is asking from, so the screen can warn before
      // they block themselves rather than after.
      yourAddress: requestContext.current().ip || null,
    });
  } catch (err) { next(err); }
});

function validateRule(body) {
  const effect = String(body.effect || '').toLowerCase();
  if (!['block', 'allow'].includes(effect)) {
    return { error: 'Choose whether this rule blocks or allows.' };
  }
  const kind = String(body.kind || '').toLowerCase();
  if (!['ip', 'cidr', 'account', 'country'].includes(kind)) {
    return { error: 'Choose what to match: an address, a range, an account or a country.' };
  }
  const value = String(body.value || '').trim();
  if (!value) return { error: 'Give the address, range, email or country code to match.' };

  // Checked at the point somebody types it, so a rule that could never match
  // is refused now rather than sitting in the table looking like protection.
  if (kind === 'ip' && !isValidIp(value)) {
    return { error: `"${value}" is not an IP address.` };
  }
  if (kind === 'cidr' && !isValidCidr(value)) {
    return { error: `"${value}" is not a range. Ranges look like 41.0.0.0/8.` };
  }
  if (kind === 'account' && !value.includes('@')) {
    return { error: 'An account rule needs an email address.' };
  }
  if (kind === 'country' && !/^[A-Za-z]{2}$/.test(value)) {
    return { error: 'A country is a two-letter code, such as ZA.' };
  }

  const reason = String(body.reason || '').trim();
  if (!reason) {
    // Not politeness. An unexplained block is one nobody will dare remove, and
    // the list turns into permanent scar tissue.
    return { error: 'Say why. A rule nobody can explain is a rule nobody will ever remove.' };
  }

  let expiresAt = null;
  if (body.expiresAt) {
    const d = new Date(body.expiresAt);
    if (Number.isNaN(d.getTime())) return { error: 'That expiry date could not be read.' };
    expiresAt = d.toISOString();
  }
  return { effect, kind, value, reason: reason.slice(0, 500), expiresAt };
}

// POST /security/access-rules
router.post('/access-rules', requireRole('admin'), async (req, res, next) => {
  try {
    const v = validateRule(req.body || {});
    if (v.error) return res.status(400).json({ error: v.error });

    // THE SELF-LOCKOUT GUARD.
    //
    // The realistic accident is not a clever attacker. It is an admin blocking
    // a range that contains their own connection — a mobile network, an office
    // — and losing the screen they would use to undo it. Refused outright,
    // because there is no good version of this and the error costs nothing to
    // recover from while the mistake could cost the site.
    if (v.effect === 'block') {
      const mine = requestContext.current().ip;
      const wouldCatchMe =
        (v.kind === 'ip' && mine && sameAddress(mine, v.value)) ||
        (v.kind === 'cidr' && mine && inCidr(mine, v.value)) ||
        (v.kind === 'account' && req.user && String(req.user.email).toLowerCase() === v.value.toLowerCase());
      if (wouldCatchMe) {
        return res.status(400).json({
          error: 'That rule would block the connection you are using right now, '
               + 'and this screen with it. Add an allow rule for yourself first, '
               + 'or apply this from somewhere else.',
        });
      }
    }

    const result = await pool.query(
      `INSERT INTO access_rules (effect, kind, value, reason, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (effect, kind, LOWER(value)) DO UPDATE SET
         reason = EXCLUDED.reason, expires_at = EXCLUDED.expires_at
       RETURNING *`,
      [v.effect, v.kind, v.value, v.reason, v.expiresAt, req.user.id]);

    // The cache is fifteen seconds, which is fine for somebody else's change
    // and infuriating for your own. Cleared so an admin's rule applies the
    // moment they press the button.
    accessControl.invalidate();
    logActivity(req.user.id, v.effect === 'block' ? 'ip_blocked' : 'ip_allowed',
      `${v.kind} ${v.value} — ${v.reason}`);
    res.status(201).json({ rule: result.rows[0] });
  } catch (err) { next(err); }
});

// DELETE /security/access-rules/:id
router.delete('/access-rules/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'A valid rule is required.' });
    const r = await pool.query('DELETE FROM access_rules WHERE id = $1 RETURNING effect, kind, value', [id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'That rule no longer exists.' });

    accessControl.invalidate();
    const row = r.rows[0];
    // Removing an ALLOW rule is the risky direction — it can expose somebody
    // to a block that was previously overridden — so it is flagged high risk.
    logActivity(req.user.id,
      row.effect === 'allow' ? 'ip_block_removed' : 'ip_block_lifted',
      `${row.kind} ${row.value}`);
    res.json({ deleted: true });
  } catch (err) { next(err); }
});


// ---------------------------------------------------------------------------
// Two-factor authentication
//
// requireAuth rather than requireRole('admin'): these act on the CALLER'S OWN
// account, never on anyone else's. There is no route here that can enrol,
// disable or reset a second factor for another person — an admin who could
// switch off a colleague's 2FA would be a way around it.
// ---------------------------------------------------------------------------

// GET /security/two-factor — where the caller stands.
router.get('/two-factor', requireAuth, async (req, res, next) => {
  try {
    const r = await pool.query(
      `SELECT two_factor_enabled, two_factor_confirmed_at,
              (SELECT count(*)::int FROM two_factor_recovery_codes
                WHERE user_id = $1 AND used_at IS NULL) AS recovery_codes_left
         FROM users WHERE id = $1`, [req.user.id]);
    const row = r.rows[0] || {};
    res.json({
      enabled: row.two_factor_enabled === true,
      confirmedAt: row.two_factor_confirmed_at || null,
      recoveryCodesLeft: row.recovery_codes_left || 0,
    });
  } catch (err) { next(err); }
});

// POST /security/two-factor/begin — produces a secret and the otpauth:// URI.
// Nothing changes about signing in until it is confirmed.
router.post('/two-factor/begin', requireAuth, async (req, res, next) => {
  try {
    if (await twoFactor.isEnabled(req.user.id)) {
      return res.status(400).json({
        error: 'Two-factor authentication is already on. Turn it off first if you want to set it up again.',
      });
    }
    const { secret, uri } = await twoFactor.beginEnrolment(req.user.id, req.user.email);
    // The secret is returned so it can be typed in by hand when a camera will
    // not read the QR code — a normal thing to need, and the alternative is
    // somebody who cannot enrol at all.
    res.json({ secret, uri, issuer: twoFactor.ISSUER });
  } catch (err) { next(err); }
});

// POST /security/two-factor/confirm — proves the app works, switches it on,
// and returns the recovery codes ONCE.
router.post('/two-factor/confirm', requireAuth, async (req, res, next) => {
  try {
    const result = await twoFactor.confirmEnrolment(req.user.id, req.body.code);
    if (!result.ok) return res.status(400).json({ error: result.error });

    logActivity(req.user.id, 'two_factor_enabled', req.user.email);
    res.json({
      enabled: true,
      recoveryCodes: result.recoveryCodes,
      note: 'Save these somewhere safe. Each one works once, and they are not shown again.',
    });
  } catch (err) { next(err); }
});

// POST /security/two-factor/disable — requires a current code, so a stolen
// session cannot simply remove the protection.
router.post('/two-factor/disable', requireAuth, async (req, res, next) => {
  try {
    const result = await twoFactor.disable(req.user.id, req.body.code);
    if (!result.ok) return res.status(400).json({ error: result.error });
    logActivity(req.user.id, 'two_factor_disabled', req.user.email);
    res.json({ enabled: false });
  } catch (err) { next(err); }
});

// POST /security/two-factor/recovery-codes — a fresh set, which invalidates
// the old ones. Requires a current code for the same reason as disabling.
router.post('/two-factor/recovery-codes', requireAuth, async (req, res, next) => {
  try {
    const check = await twoFactor.verifySecondFactor(req.user.id, req.body.code);
    if (!check.ok) return res.status(400).json({ error: 'That code is not right.' });
    const codes = await twoFactor.regenerateRecoveryCodes(req.user.id);
    logActivity(req.user.id, 'two_factor_recovery_codes_regenerated', req.user.email);
    res.json({ recoveryCodes: codes, note: 'The previous codes no longer work.' });
  } catch (err) { next(err); }
});


// ---------------------------------------------------------------------------
// Bot defence
// ---------------------------------------------------------------------------

// GET /security/altcha-challenge — public, and it has to be.
//
// The form that needs it is used by people who are not signed in: a contact
// enquiry, a nomination, a comment. Stateless, so requesting a million of
// these costs a hash each and stores nothing.
router.get('/altcha-challenge', (req, res) => {
  res.set('Cache-Control', 'no-store'); // a reused challenge is a solved one
  res.json(altcha.createChallenge());
});

module.exports = router;
