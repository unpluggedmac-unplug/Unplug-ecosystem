const express = require('express');
const pool = require('../db');
const { requireRole } = require('../middleware/auth');
const { publicSubmitLimiter } = require('../middleware/rateLimit');
const honeypot = require('../middleware/honeypot');

const router = express.Router();

// POST /newsletter/subscribe — public. Stores the email; duplicate signups
// are silently ignored (ON CONFLICT), so re-subscribing is harmless.
router.post('/subscribe', publicSubmitLimiter, honeypot, async (req, res, next) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'A valid email address is required.' });
    }
    await pool.query(
      `INSERT INTO newsletter_subscribers (email) VALUES ($1) ON CONFLICT (email) DO NOTHING`,
      [email]
    );
    res.status(201).json({ message: 'Subscribed — welcome to Unplug! You\'ll get our stories every Friday.' });
  } catch (err) {
    next(err);
  }
});

// GET /newsletter/subscribers — admin, newest first (for review/export).
router.get('/subscribers', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, email, subscribed_at FROM newsletter_subscribers ORDER BY subscribed_at DESC`
    );
    res.json({ subscribers: result.rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
