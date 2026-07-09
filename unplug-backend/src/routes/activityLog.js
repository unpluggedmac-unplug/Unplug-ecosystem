const express = require('express');
const pool = require('../db');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

async function logActivity(adminUserId, action, details) {
  try {
    await pool.query(
      `INSERT INTO admin_activity_log (admin_user_id, action, details) VALUES ($1, $2, $3)`,
      [adminUserId, action, details || null]
    );
  } catch (err) {
    console.error('[activity log] failed to record:', err.message);
  }
}

// Simplified — no JOIN, just the log table itself, to remove any risk
// from the users table relationship. If this still fails, the error
// detail below will show exactly why.
router.get('/', requireRole('admin'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, admin_user_id, action, details, created_at
       FROM admin_activity_log
       ORDER BY created_at DESC
       LIMIT 100`
    );
    res.json({ activity: result.rows });
  } catch (err) {
    console.error('[activity log] query failed:', err);
    // TEMPORARY — includes the real error message in the response so we
    // can see exactly what's wrong, instead of a generic failure.
    // Remove this detail once it's confirmed working.
    res.status(500).json({ error: 'Could not load activity log.', detail: err.message, code: err.code });
  }
});

module.exports = { router, logActivity };
