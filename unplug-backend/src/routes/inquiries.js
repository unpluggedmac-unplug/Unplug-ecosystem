const express = require('express');
const pool = require('../db');
const { requireRole } = require('../middleware/auth');
const { publicSubmitLimiter } = require('../middleware/rateLimit');
const honeypot = require('../middleware/honeypot');

const router = express.Router();

// POST /inquiries — public. This is what the site's Contact form submits to.
router.post('/', publicSubmitLimiter, honeypot, async (req, res, next) => {
  try {
    const { name, email, subject, message } = req.body;
    if (!name || !email || !message) {
      return res.status(400).json({ error: 'name, email, and message are required.' });
    }
    await pool.query(
      `INSERT INTO inquiries (name, email, subject, message) VALUES ($1, $2, $3, $4)`,
      [name, email, subject || null, message]
    );
    res.status(201).json({ message: 'Thanks — we\'ll get back to you soon.' });
  } catch (err) {
    next(err);
  }
});

// GET /inquiries — admin-only, newest first. (Mounted at /inquiries
// alongside the public POST above — different HTTP methods on the same
// path work fine side by side.)
router.get('/', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(`SELECT * FROM inquiries ORDER BY created_at DESC`);
    res.json({ inquiries: result.rows });
  } catch (err) {
    next(err);
  }
});

// PATCH /inquiries/:id/status — admin-only, mark as read or replied.
router.patch('/:id/status', requireRole('admin'), async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!['new', 'read', 'replied'].includes(status)) {
      return res.status(400).json({ error: 'status must be one of: new, read, replied.' });
    }
    const result = await pool.query(
      `UPDATE inquiries SET status = $1 WHERE id = $2 RETURNING *`,
      [status, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Inquiry not found.' });
    }
    res.json({ inquiry: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
