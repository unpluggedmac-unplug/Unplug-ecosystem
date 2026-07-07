const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const { getPagination, paginationMeta } = require('../utils/pagination');

const router = express.Router();

// GET /events/upcoming — public, approved events from today onward.
// Used directly by the homepage's "Upcoming Events" section.
router.get('/upcoming', async (req, res, next) => {
  try {
    const { page, limit, offset } = getPagination(req);
    const condition = `status = 'approved' AND event_date >= CURRENT_DATE`;

    const countResult = await pool.query(`SELECT COUNT(*) FROM events WHERE ${condition}`);

    const result = await pool.query(
      `SELECT id, name, event_date, venue, description
       FROM events
       WHERE ${condition}
       ORDER BY event_date ASC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    res.json({
      events: result.rows,
      pagination: paginationMeta(page, limit, parseInt(countResult.rows[0].count, 10)),
    });
  } catch (err) {
    next(err);
  }
});

// POST /events — member submits (enters as 'pending').
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { name, eventDate, venue, description, displayStartDate } = req.body;
    if (!name || !eventDate) {
      return res.status(400).json({ error: 'name and eventDate are required.' });
    }

    const result = await pool.query(
      `INSERT INTO events (organizer_user_id, name, event_date, venue, description, display_start_date, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'awaiting_payment')
       RETURNING *`,
      [req.user.id, name, eventDate, venue || null, description || null, displayStartDate || null]
    );

    res.status(201).json({
      event: result.rows[0],
      message: 'Event created — call POST /payments/initiate with linkedType "event_listing" and this event\'s id (R300.00) to submit it for approval.',
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
