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

router.get('/', requireRole('admin'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, admin_user_id, action, details, created_at
       FROM admin_activity_log
       ORDER BY created_at DESC
       LIMIT 200`
    );
    res.json({ activity: result.rows });
  } catch (err) {
    // The raw error goes to the server log, not the response — database
    // messages can name tables and columns, which is detail an attacker
    // shouldn't get for free. (This previously returned err.message to the
    // client as a temporary debugging aid.)
    console.error('[activity log] query failed:', err);
    res.status(500).json({ error: 'Could not load activity log.' });
  }
});

module.exports = { router, logActivity };
