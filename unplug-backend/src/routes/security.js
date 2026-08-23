// What is currently being attacked, and the controls for it.
//
// Admin-only throughout. The point of this screen is to answer two questions
// quickly when something looks wrong: is anyone working through our accounts
// right now, and can I let this particular person back in.

const express = require('express');
const { requireRole } = require('../middleware/auth');
const { logActivity } = require('./activityLog');
const loginAttempts = require('../utils/loginAttempts');

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

module.exports = router;
