const express = require('express');
const pool = require('../db');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

// GET /birthdays/today — public. Used directly by the homepage's
// "Celebrating Today" strip.
router.get('/today', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, name, photo_url, message
       FROM birthdays
       WHERE birth_month = EXTRACT(MONTH FROM CURRENT_DATE)
         AND birth_day = EXTRACT(DAY FROM CURRENT_DATE)`
    );
    res.json({ birthdays: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /birthdays/month?month=7 — public. Powers "View The Full Month".
// Defaults to the current month if not specified.
router.get('/month', async (req, res, next) => {
  try {
    const month = parseInt(req.query.month, 10) || new Date().getMonth() + 1;
    const result = await pool.query(
      `SELECT id, name, birth_month, birth_day, photo_url, message
       FROM birthdays
       WHERE birth_month = $1
       ORDER BY birth_day ASC`,
      [month]
    );
    res.json({ birthdays: result.rows });
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
