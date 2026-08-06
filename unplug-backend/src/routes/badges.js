// Members, Profile Social Interaction & Community System — Badges, a
// genuine second progression track distinct from Achievements
// (074_recognition_achievements_missions.sql). Admin-granted only — see
// 091_badges_and_hof_linking.sql for why.

const express = require('express');
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// GET /badges — public, every enabled badge type (what's obtainable).
router.get('/', async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT code, label, description, emoji, category FROM badges WHERE is_enabled = TRUE ORDER BY sort_order ASC'
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
      `SELECT b.code, b.label, b.description, b.emoji, b.category, ub.awarded_at
         FROM user_badges ub JOIN badges b ON b.code = ub.badge_code
        WHERE ub.user_id = $1
        ORDER BY ub.awarded_at DESC`,
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
    const result = await pool.query(
      `INSERT INTO badges (code, label, description, emoji, category, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING code`,
      [code, label, description, emoji, category || 'general', sortOrder || 0]
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

// POST /badges/admin/:code/award — body { userId, reason? }. Idempotent
// per (user, badge) — awarding the same badge twice is a no-op, same as
// every other "toggle/grant" action in this engine.
router.post('/admin/:code/award', requireRole('admin'), async (req, res, next) => {
  try {
    const userId = Number(req.body.userId);
    if (!Number.isInteger(userId)) {
      return res.status(400).json({ error: 'A valid userId is required.' });
    }
    const result = await pool.query('SELECT award_badge($1, $2, $3, $4) AS awarded', [
      userId, req.params.code, req.user.id, req.body.reason || null,
    ]);
    res.json({ awarded: result.rows[0].awarded });
  } catch (err) {
    next(err);
  }
});

// DELETE /badges/admin/:code/revoke/:userId — undo a mistaken award.
router.delete('/admin/:code/revoke/:userId', requireRole('admin'), async (req, res, next) => {
  try {
    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId)) {
      return res.status(400).json({ error: 'A valid userId is required.' });
    }
    await pool.query('DELETE FROM user_badges WHERE user_id = $1 AND badge_code = $2', [userId, req.params.code]);
    res.json({ revoked: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
