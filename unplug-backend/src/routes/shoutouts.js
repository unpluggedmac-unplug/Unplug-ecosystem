const express = require('express');
const pool = require('../db');

const router = express.Router();

// GET /shoutouts/today — public. Returns the single shoutout for today,
// powering the homepage "The Guy Says" banner. One shoutout is picked per
// calendar day and stays stable for the whole day (so the section doesn't
// flicker between visitors), then rotates to a new one tomorrow.
//
// Selection order:
//   1. If today's shoutout is already materialized in shoutout_schedule,
//      return it.
//   2. Otherwise pick the oldest approved nomination that has never been
//      scheduled before and lock it in for today.
//   3. If there are no approved nominations left, fall back to a seeded
//      South African name (rotated by day-of-year so it changes daily).
// Steps 2/3 use INSERT ... ON CONFLICT DO NOTHING so concurrent first-of-day
// requests can't create duplicate/conflicting rows.
router.get('/today', async (req, res, next) => {
  try {
    // 2. Try to lock in the next approved nomination for today.
    await pool.query(
      `INSERT INTO shoutout_schedule (shoutout_date, nomination_id)
       SELECT CURRENT_DATE, n.id
       FROM shoutout_nominations n
       WHERE n.status = 'approved'
         AND NOT EXISTS (
           SELECT 1 FROM shoutout_schedule s WHERE s.nomination_id = n.id
         )
       ORDER BY n.created_at ASC
       LIMIT 1
       ON CONFLICT (shoutout_date) DO NOTHING`
    );

    // 3. If nothing got scheduled (no approved nominations available), use a
    // seeded fallback name, rotated by day-of-year so it differs each day.
    await pool.query(
      `INSERT INTO shoutout_schedule (shoutout_date, fallback_name)
       SELECT CURRENT_DATE, f.name
       FROM shoutout_fallbacks f
       WHERE (SELECT COUNT(*) FROM shoutout_fallbacks) > 0
       ORDER BY f.id
       OFFSET (
         EXTRACT(DOY FROM CURRENT_DATE)::int
         % GREATEST((SELECT COUNT(*) FROM shoutout_fallbacks), 1)
       )
       LIMIT 1
       ON CONFLICT (shoutout_date) DO NOTHING`
    );

    // Read back whatever is now locked in for today.
    const result = await pool.query(
      `SELECT s.shoutout_date,
              COALESCE(n.nominee_name, s.fallback_name) AS name,
              n.message,
              (s.nomination_id IS NOT NULL) AS from_nomination
       FROM shoutout_schedule s
       LEFT JOIN shoutout_nominations n ON n.id = s.nomination_id
       WHERE s.shoutout_date = CURRENT_DATE`
    );

    if (result.rows.length === 0) {
      // Only possible if there are zero fallbacks AND zero approved
      // nominations — return an empty payload the frontend can handle.
      return res.json({ shoutout: null });
    }

    const row = result.rows[0];
    res.json({
      shoutout: {
        name: row.name,
        message: row.message || null,
        date: row.shoutout_date,
        fromNomination: row.from_nomination,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /shoutouts/nominate — public. Anyone can suggest a name+surname for a
// future shoutout. Enters as 'pending'; nothing appears publicly until an
// admin approves it, so unauthenticated submission is safe.
router.post('/nominate', async (req, res, next) => {
  try {
    const { nomineeName, message, email } = req.body;
    const name = (nomineeName || '').trim();
    if (!name) {
      return res.status(400).json({ error: 'A name and surname are required.' });
    }
    if (name.length > 200) {
      return res.status(400).json({ error: 'That name is too long.' });
    }

    await pool.query(
      `INSERT INTO shoutout_nominations (nominee_name, message, submitted_by_email)
       VALUES ($1, $2, $3)`,
      [name, (message || '').trim() || null, (email || '').trim() || null]
    );
    res.status(201).json({
      message: 'Thanks! Your shoutout nomination has been submitted for review.',
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
