const express = require('express');
const pool = require('../db');
const { requireRole } = require('../middleware/auth');
const { publicSubmitLimiter } = require('../middleware/rateLimit');
const honeypot = require('../middleware/honeypot');
const { sendDueBirthdayEmails } = require('../utils/birthdayMailer');

const router = express.Router();

// GET /birthdays/today — public. Used directly by the homepage's
// "Celebrating Today" strip. Approved birthdays only.
router.get('/today', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, name, photo_url, message
       FROM birthdays
       WHERE status = 'approved'
         AND birth_month = EXTRACT(MONTH FROM CURRENT_DATE)
         AND birth_day = EXTRACT(DAY FROM CURRENT_DATE)`
    );
    res.json({ birthdays: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /birthdays/month?month=7 — public. Powers "View This Month List".
// Defaults to the current month if not specified. Approved only.
router.get('/month', async (req, res, next) => {
  try {
    const month = parseInt(req.query.month, 10) || new Date().getMonth() + 1;
    const result = await pool.query(
      `SELECT id, name, birth_month, birth_day, photo_url, message
       FROM birthdays
       WHERE status = 'approved' AND birth_month = $1
       ORDER BY birth_day ASC`,
      [month]
    );
    res.json({ birthdays: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /birthdays/submit — public submission (name, date, photo). Enters
// 'pending'; shows on the homepage once an admin approves it.
router.post('/submit', publicSubmitLimiter, honeypot, async (req, res, next) => {
  try {
    const { name, birthMonth, birthDay, photoUrl, message, email } = req.body;
    const m = parseInt(birthMonth, 10);
    const d = parseInt(birthDay, 10);
    const address = (email || '').trim().toLowerCase();
    if (!name || !m || !d || m < 1 || m > 12 || d < 1 || d > 31) {
      return res.status(400).json({ error: 'name and a valid birthday date are required.' });
    }
    // Required now: without it there's nobody to send the birthday greeting
    // to, which is the whole point of collecting the date.
    if (!address || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
      return res.status(400).json({ error: 'A valid email address is required so we can send the birthday message.' });
    }
    // Guard against impossible dates like 31 February, which the per-column
    // checks allow individually but which no calendar will ever match — the
    // greeting would silently never send.
    const daysInMonth = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
    if (d > daysInMonth) {
      return res.status(400).json({ error: `${d} is not a valid day in that month.` });
    }
    await pool.query(
      `INSERT INTO birthdays (name, birth_month, birth_day, photo_url, message, email, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
      [name.trim(), m, d, (photoUrl || '').trim() || null, (message || '').trim() || null, address]
    );
    res.status(201).json({ message: 'Thanks! The birthday has been submitted for review.' });
  } catch (err) {
    next(err);
  }
});

// GET /birthdays/all — every approved birthday, ordered through the calendar
// year from 1 January. Admin-only because it exposes the email addresses.
router.get('/all', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT b.id, b.name, b.birth_month, b.birth_day, b.email, b.photo_url,
              b.message, b.status, b.created_at,
              (s.birthday_id IS NOT NULL) AS greeted_this_year
         FROM birthdays b
         LEFT JOIN birthday_emails_sent s
           ON s.birthday_id = b.id
          AND s.sent_year = EXTRACT(YEAR FROM (now() AT TIME ZONE 'Africa/Johannesburg'))::int
        WHERE b.status = 'approved'
        ORDER BY b.birth_month, b.birth_day, b.name`
    );
    res.json({ birthdays: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /birthdays/send-greetings — sends today's birthday emails.
//
// Render's free tier sleeps when idle and has no cron, so this is exposed as
// an endpoint rather than hidden in a timer: an external scheduler (the same
// uptime pinger that keeps the instance warm) can call it daily. It's
// idempotent, so calling it repeatedly is harmless.
//
// Authorised either as an admin, or with BIRTHDAY_CRON_SECRET as a bearer
// token so a scheduler can call it without an admin login.
router.post('/send-greetings', async (req, res, next) => {
  try {
    const secret = process.env.BIRTHDAY_CRON_SECRET;
    const auth = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const isAdmin = req.user && req.user.role === 'admin';
    const hasSecret = secret && auth && auth === secret;
    if (!isAdmin && !hasSecret) {
      return res.status(401).json({ error: 'Not authorised to run birthday greetings.' });
    }
    const result = await sendDueBirthdayEmails();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /birthdays/pending — admin. Public submissions awaiting approval.
router.get('/pending', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, name, birth_month, birth_day, photo_url, created_at
       FROM birthdays WHERE status = 'pending' ORDER BY created_at ASC`
    );
    res.json({ birthdays: result.rows });
  } catch (err) {
    next(err);
  }
});

// PATCH /birthdays/:id/approve | reject — admin moderation of submissions.
router.patch('/:id/:action', requireRole('admin'), async (req, res, next) => {
  try {
    const { action } = req.params;
    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'action must be approve or reject.' });
    }
    const status = action === 'approve' ? 'approved' : 'rejected';
    const result = await pool.query(
      `UPDATE birthdays SET status = $1 WHERE id = $2 RETURNING id`,
      [status, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Birthday not found.' });
    res.json({ id: result.rows[0].id, status });
  } catch (err) {
    next(err);
  }
});

// POST /birthdays — admin-only, once-off entry (per the locked Blueprint,
// there is no public/member submission route for birthdays).
router.post('/', requireRole('admin'), async (req, res, next) => {
  try {
    const { profileId, name, birthMonth, birthDay, recurring, photoUrl, message } = req.body;
    if (!name || !birthMonth || !birthDay) {
      return res.status(400).json({ error: 'name, birthMonth, and birthDay are required.' });
    }

    const result = await pool.query(
      `INSERT INTO birthdays (profile_id, name, birth_month, birth_day, recurring, photo_url, message)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [profileId || null, name, birthMonth, birthDay, recurring !== false, photoUrl || null, message || null]
    );

    res.status(201).json({ birthday: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /birthdays/:id — admin-only, matches the "Remove" action in the
// Admin Dashboard mockup's Scheduled Birthdays table.
router.delete('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query('DELETE FROM birthdays WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Birthday entry not found.' });
    }
    res.json({ message: 'Removed.' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
