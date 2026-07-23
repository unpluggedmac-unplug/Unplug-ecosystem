const express = require('express');
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { publishesFree, statusForNewSubmission } = require("../utils/publishingRights");
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
      `SELECT id, name, event_date, venue, description, image_url, entrance_fee,
              contact_details, event_link,
              to_char(start_time, 'HH24:MI') AS start_time,
              to_char(end_time, 'HH24:MI') AS end_time
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
    const { name, eventDate, venue, description, displayStartDate,
            imageUrl, entranceFee, contactDetails, eventLink, startTime, endTime } = req.body;
    if (!name || !eventDate) {
      return res.status(400).json({ error: 'name and eventDate are required.' });
    }

    const profileResult = await pool.query(
      'SELECT id, free_event_credits FROM profiles WHERE user_id = $1',
      [req.user.id]
    );
    const hasCredit = profileResult.rows.length > 0 && profileResult.rows[0].free_event_credits > 0;

    const result = await pool.query(
      `INSERT INTO events (organizer_user_id, name, event_date, venue, description, display_start_date,
                           image_url, entrance_fee, contact_details, event_link, start_time, end_time, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [req.user.id, name, eventDate, venue || null, description || null, displayStartDate || null,
       imageUrl || null, entranceFee || null, contactDetails || null, eventLink || null,
       startTime || null, endTime || null, statusForNewSubmission(req.user, hasCredit)]
    );

    if (hasCredit && !publishesFree(req.user)) {
      await pool.query('UPDATE profiles SET free_event_credits = free_event_credits - 1 WHERE id = $1', [profileResult.rows[0].id]);
    }

    res.status(201).json({
      event: result.rows[0],
      message: hasCredit
        ? 'Event created using your free Event credit — submitted for approval, no payment needed.'
        : 'Event created — call POST /payments/initiate with linkedType "event_listing" and this event\'s id (R300.00) to submit it for approval.',
    });
  } catch (err) {
    next(err);
  }
});

// GET /events/admin/all — admin, every event at every status (incl. past),
// for the Calendar Events editor. Newest event date first.
router.get('/admin/all', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, name, event_date, venue, description, image_url, entrance_fee,
              contact_details, event_link, display_start_date, status,
              to_char(start_time, 'HH24:MI') AS start_time,
              to_char(end_time, 'HH24:MI') AS end_time
         FROM events
        ORDER BY event_date DESC
        LIMIT 300`
    );
    res.json({ events: result.rows });
  } catch (err) {
    next(err);
  }
});

// PATCH /events/:id — admin edits any calendar event. Only the fields sent are
// changed, so editing one field never blanks the rest. A blank string clears
// an optional field.
router.patch('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'A valid event id is required.' });

    const map = {
      name: 'name', eventDate: 'event_date', venue: 'venue', description: 'description',
      displayStartDate: 'display_start_date', imageUrl: 'image_url', entranceFee: 'entrance_fee',
      contactDetails: 'contact_details', eventLink: 'event_link',
      startTime: 'start_time', endTime: 'end_time',
    };
    const sets = [];
    const values = [];
    for (const [bodyKey, column] of Object.entries(map)) {
      if (req.body[bodyKey] === undefined) continue;
      let v = req.body[bodyKey];
      if (typeof v === 'string') { v = v.trim(); if (v === '') v = null; }
      // name and event_date can't be cleared — they're required to render.
      if ((column === 'name' || column === 'event_date') && !v) {
        return res.status(400).json({ error: 'Name and date can\'t be blank.' });
      }
      values.push(v);
      sets.push(`${column} = $${values.length}`);
    }
    if (sets.length === 0) return res.status(400).json({ error: 'No fields to update.' });

    values.push(id);
    const result = await pool.query(
      `UPDATE events SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Event not found.' });
    res.json({ event: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
