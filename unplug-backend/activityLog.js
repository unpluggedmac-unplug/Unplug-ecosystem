const express = require('express');
const pool = require('../db');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

// Call this from any admin route to record what happened. Kept as a
// simple, reusable one-liner rather than middleware, so it's obvious
// exactly which actions get logged just by reading the route file.
//
// Usage: await logActivity(req.user.id, 'profile_approved', `Profile #${id}`);
async function logActivity(adminUserId, action, details) {
  try {
    await pool.query(
      `INSERT INTO admin_activity_log (admin_user_id, action, details) VALUES ($1, $2, $3)`,
      [adminUserId, action, details || null]
    );
  } catch (err) {
    // Logging should never break the actual action it's attached to —
    // if this fails, just note it in the server console and move on.
    console.error('[activity log] failed to record:', err.message);
  }
}

// GET /admin/activity-log — most recent 100 actions, newest first.
router.get('/', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT l.id, l.action, l.details, l.created_at, u.email AS admin_email
       FROM admin_activity_log l
       LEFT JOIN users u ON u.id = l.admin_user_id
       ORDER BY l.created_at DESC
       LIMIT 100`
    );
    res.json({ activity: result.rows });
  } catch (err) {
    next(err);
  }
});

module.exports = { router, logActivity };
