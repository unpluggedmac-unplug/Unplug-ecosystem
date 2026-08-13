// Members, Profile Social Interaction & Community System — Badges, a
// genuine second progression track distinct from Achievements
// (074_recognition_achievements_missions.sql). Admin-granted only — see
// 091_badges_and_hof_linking.sql for why.

const express = require('express');
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logActivity } = require('./activityLog');

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

// GET /badges/admin/all?q=&category=&enabled=&limit=&offset=
//
// Searchable and paginated. The catalogue is 2000+ badges, so returning all
// of them was fine when there were forty and is not now: it is a slow
// response and, more to the point, an unusable list. Every filter is
// optional, so an existing caller that passes nothing still works — it just
// gets the first page instead of everything, with `total` saying how many
// there really are.
router.get('/admin/all', requireRole('admin'), async (req, res, next) => {
  try {
    const conditions = [];
    const values = [];
    if (req.query.q) {
      values.push(`%${String(req.query.q).trim()}%`);
      conditions.push(`(code ILIKE $${values.length} OR label ILIKE $${values.length} OR description ILIKE $${values.length})`);
    }
    if (req.query.category) {
      values.push(String(req.query.category).trim());
      conditions.push(`category = $${values.length}`);
    }
    if (req.query.enabled === 'true' || req.query.enabled === 'false') {
      values.push(req.query.enabled === 'true');
      conditions.push(`is_enabled = $${values.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    // Capped rather than trusted: an admin page asking for 2000 rows at once
    // is a mistake, not a request worth honouring.
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const [rows, count] = await Promise.all([
      pool.query(
        `SELECT * FROM badges ${where}
          ORDER BY sort_order ASC, category ASC, code ASC
          LIMIT ${limit} OFFSET ${offset}`,
        values
      ),
      pool.query(`SELECT COUNT(*)::int AS n FROM badges ${where}`, values),
    ]);

    res.json({
      badges: rows.rows,
      total: count.rows[0].n,
      limit,
      offset,
      hasMore: offset + rows.rows.length < count.rows[0].n,
    });
  } catch (err) {
    next(err);
  }
});

// GET /badges/admin/categories — every category with how many badges are in
// it, so the admin can narrow 2000 down before searching.
router.get('/admin/categories', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT category, COUNT(*)::int AS badges,
              COUNT(*) FILTER (WHERE is_enabled)::int AS enabled
         FROM badges GROUP BY category ORDER BY category ASC`
    );
    res.json({ categories: result.rows });
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

// POST /badges/admin/:code/award-bulk — body { userIds: [], reason?, awardMonth?, awardYear? }
//
// One badge, many members, one action. Awarding a "Top 10 August 2026" badge
// to thirty finalists one click at a time is where an admin gives up halfway
// and the thirty-first never gets it.
//
// Every member is awarded through the SAME award_badge() function the single
// award uses — no second code path — so the period rules, the follower
// fan-out and the notification behave identically whether one person or a
// hundred were selected.
//
// Deliberately NOT one transaction. A single bad id in a list of fifty must
// not silently discard the forty-nine that were fine; each is applied on its
// own and the response reports exactly what happened to every one.
router.post('/admin/:code/award-bulk', requireRole('admin'), async (req, res, next) => {
  try {
    const raw = Array.isArray(req.body.userIds) ? req.body.userIds : [];
    // De-duplicated before anything else: the same member twice in one
    // request would otherwise be reported as awarded and then "already had
    // it", which reads like a bug.
    const userIds = [...new Set(raw.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!userIds.length) {
      return res.status(400).json({ error: 'Choose at least one member to award this badge to.' });
    }
    if (userIds.length > 500) {
      return res.status(400).json({ error: 'Award to at most 500 members at a time.' });
    }
    const period = parsePeriod(req.body.awardMonth, req.body.awardYear);
    if (!period) return res.status(400).json({ error: PERIOD_ERROR });

    const badge = await pool.query('SELECT code, label, is_enabled FROM badges WHERE code = $1', [req.params.code]);
    if (!badge.rows.length) return res.status(404).json({ error: 'Badge not found.' });

    // Named up front so a mistyped id is reported as "no such member" rather
    // than silently counted as "already had it".
    const known = await pool.query('SELECT id, email FROM users WHERE id = ANY($1)', [userIds]);
    const emailById = new Map(known.rows.map((u) => [u.id, u.email]));

    const awarded = [];
    const alreadyHad = [];
    const notFound = [];
    const failed = [];

    for (const userId of userIds) {
      if (!emailById.has(userId)) { notFound.push(userId); continue; }
      try {
        const r = await pool.query('SELECT award_badge($1, $2, $3, $4, $5, $6) AS awarded', [
          userId, req.params.code, req.user.id, req.body.reason || null, period.month, period.year,
        ]);
        (r.rows[0].awarded ? awarded : alreadyHad).push(userId);
      } catch (err) {
        failed.push({ userId, error: err.message });
      }
    }

    await logActivity(req.user.id, 'badge_awarded_bulk',
      `Awarded "${badge.rows[0].label}" (${req.params.code}) to ${awarded.length} member(s)`
      + `${alreadyHad.length ? `, ${alreadyHad.length} already had it` : ''}`
      + `${notFound.length ? `, ${notFound.length} not found` : ''}`
      + `${period.month ? ` for ${period.month}/${period.year}` : ''}`).catch(() => {});

    res.json({
      badge: req.params.code,
      awarded: awarded.length,
      alreadyHad: alreadyHad.length,
      notFound,
      failed,
      badgeDisabled: badge.rows[0].is_enabled === false,
      message: `${awarded.length} awarded`
        + (alreadyHad.length ? `, ${alreadyHad.length} already had it` : '')
        + (notFound.length ? `, ${notFound.length} not found` : '')
        + (failed.length ? `, ${failed.length} failed` : '') + '.',
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
