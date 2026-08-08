// Members, Profile Social Interaction & Community System — Badges, a
// genuine second progression track distinct from Achievements
// (074_recognition_achievements_missions.sql). Admin-granted only — see
// 091_badges_and_hof_linking.sql for why.

const express = require('express');
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// Month/year are a pair — see 099_badge_month_year.sql. Returns
// { month, year } with both set or both null, or null if the input is
// invalid so the caller can reject it rather than silently storing junk.
function parsePeriod(rawMonth, rawYear) {
  const hasMonth = rawMonth !== undefined && rawMonth !== null && rawMonth !== '';
  const hasYear = rawYear !== undefined && rawYear !== null && rawYear !== '';
  if (!hasMonth && !hasYear) return { month: null, year: null };
  if (hasMonth !== hasYear) return null; // one without the other identifies nothing
  const month = Number(rawMonth);
  const year = Number(rawYear);
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return null;
  return { month, year };
}

const PERIOD_ERROR = 'Give both a month (1-12) and a year (2000-2100), or neither.';

// GET /badges — public, every enabled badge type (what's obtainable).
router.get('/', async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT code, label, description, emoji, category, award_month, award_year FROM badges WHERE is_enabled = TRUE ORDER BY sort_order ASC'
    );
    res.json({ badges: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /badges/user/:userId — public, the badges a specific member has earned.
router.get('/user/:userId', async (req, res, next) => {
  try {
    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId)) {
      return res.status(400).json({ error: 'A valid userId is required.' });
    }
    const result = await pool.query(
      // The award's own period, not the badge type's — the same badge held
      // for two months is two rows and each should report its own.
      `SELECT b.code, b.label, b.description, b.emoji, b.category, ub.awarded_at,
              ub.award_month, ub.award_year
         FROM user_badges ub JOIN badges b ON b.code = ub.badge_code
        WHERE ub.user_id = $1
        ORDER BY ub.award_year DESC NULLS LAST, ub.award_month DESC NULLS LAST, ub.awarded_at DESC`,
      [userId]
    );
    res.json({ badges: result.rows });
  } catch (err) {
    next(err);
  }
});

// -- Admin --

// GET /badges/admin/all — every badge type, enabled or not.
router.get('/admin/all', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM badges ORDER BY sort_order ASC, code ASC');
    res.json({ badges: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /badges/admin — create a badge type.
router.post('/admin', requireRole('admin'), async (req, res, next) => {
  try {
    const { code, label, description, emoji, category, sortOrder } = req.body;
    if (!code || !label || !description || !emoji) {
      return res.status(400).json({ error: 'code, label, description and emoji are all required.' });
    }
    const period = parsePeriod(req.body.awardMonth, req.body.awardYear);
    if (!period) return res.status(400).json({ error: PERIOD_ERROR });
    const result = await pool.query(
      `INSERT INTO badges (code, label, description, emoji, category, sort_order, award_month, award_year)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING code`,
      [code, label, description, emoji, category || 'general', sortOrder || 0, period.month, period.year]
    );
    res.status(201).json({ code: result.rows[0].code });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: `A badge with code "${req.body.code}" already exists.` });
    next(err);
  }
});

// PATCH /badges/admin/:code — edit a badge type, including enable/disable.
router.patch('/admin/:code', requireRole('admin'), async (req, res, next) => {
  try {
    const fields = [];
    const values = [];
    const set = (column, value) => { values.push(value); fields.push(`${column} = $${values.length}`); };
    const b = req.body;
    if (b.label !== undefined) set('label', b.label);
    if (b.description !== undefined) set('description', b.description);
    if (b.emoji !== undefined) set('emoji', b.emoji);
    if (b.category !== undefined) set('category', b.category);
    if (b.sortOrder !== undefined) set('sort_order', b.sortOrder);
    if (b.isEnabled !== undefined) set('is_enabled', !!b.isEnabled);
    // Month and year move together, so they are only touched when at least
    // one was sent — and then both are written, which is also how the period
    // gets cleared (send both empty).
    if (b.awardMonth !== undefined || b.awardYear !== undefined) {
      const period = parsePeriod(b.awardMonth, b.awardYear);
      if (!period) return res.status(400).json({ error: PERIOD_ERROR });
      set('award_month', period.month);
      set('award_year', period.year);
    }
    if (!fields.length) return res.status(400).json({ error: 'Nothing to update.' });
    values.push(req.params.code);
    const result = await pool.query(
      `UPDATE badges SET ${fields.join(', ')} WHERE code = $${values.length} RETURNING code`,
      values
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Badge not found.' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// POST /badges/admin/:code/award — body { userId, reason?, awardMonth?, awardYear? }.
//
// Idempotent per (user, badge, period): awarding the same undated badge
// twice is still a no-op, but the same badge for a DIFFERENT month is a
// genuine second award. Omitting the period inherits the badge type's own,
// so a badge that already is "August 2026" needs nothing retyped here.
router.post('/admin/:code/award', requireRole('admin'), async (req, res, next) => {
  try {
    const userId = Number(req.body.userId);
    if (!Number.isInteger(userId)) {
      return res.status(400).json({ error: 'A valid userId is required.' });
    }
    const period = parsePeriod(req.body.awardMonth, req.body.awardYear);
    if (!period) return res.status(400).json({ error: PERIOD_ERROR });

    // Checked here so that a FALSE from award_badge means one thing only:
    // they already have it. The function returns FALSE for an unknown code
    // too, and the two used to be indistinguishable to the caller.
    const badge = await pool.query('SELECT code, is_enabled FROM badges WHERE code = $1', [req.params.code]);
    if (!badge.rows.length) return res.status(404).json({ error: 'Badge not found.' });

    const result = await pool.query('SELECT award_badge($1, $2, $3, $4, $5, $6) AS awarded', [
      userId, req.params.code, req.user.id, req.body.reason || null, period.month, period.year,
    ]);
    res.json({
      awarded: result.rows[0].awarded,
      // A disabled badge is still awardable on purpose, but the admin should
      // know it is not in the public "obtainable badges" list.
      badgeDisabled: badge.rows[0].is_enabled === false,
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /badges/admin/:code/revoke/:userId — undo a mistaken award.
//
// ?awardMonth=&awardYear= revokes one specific period. Without them this
// still removes every award of the badge for that member, which is what an
// undated badge needs and what this route always did — but for a member who
// holds the badge for several months that is now a much bigger action than
// it used to be, so the response reports how many were actually removed.
router.delete('/admin/:code/revoke/:userId', requireRole('admin'), async (req, res, next) => {
  try {
    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId)) {
      return res.status(400).json({ error: 'A valid userId is required.' });
    }
    const period = parsePeriod(req.query.awardMonth, req.query.awardYear);
    if (!period) return res.status(400).json({ error: PERIOD_ERROR });

    const result = period.month === null
      ? await pool.query('DELETE FROM user_badges WHERE user_id = $1 AND badge_code = $2', [userId, req.params.code])
      : await pool.query(
        `DELETE FROM user_badges
          WHERE user_id = $1 AND badge_code = $2 AND award_month = $3 AND award_year = $4`,
        [userId, req.params.code, period.month, period.year]
      );
    res.json({ revoked: true, removed: result.rowCount });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
