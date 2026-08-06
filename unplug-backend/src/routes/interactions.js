// Universal Interaction Engine — Members/Profile Social System Phase 1.
//
// One reusable engine for like/dislike/save across every content type
// the brief lists (article, profile, gallery_image, event,
// marketplace_listing) instead of one route file per type. Comments stay
// on their existing per-type route (comments.js) for this phase — Phase
// 2 generalises those the same way.
//
// target_id existence is checked at the app layer, not via a DB foreign
// key — target_type is polymorphic (points at five different tables),
// which Postgres can't express as a single FK. This mirrors the existing
// gallery_images.owner_type/owner_id pattern in this codebase, which has
// the same limitation and the same app-layer check.

const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const TARGET_TYPES = ['article', 'profile', 'gallery_image', 'event', 'marketplace_listing'];
const TARGET_TABLE = {
  article: 'articles',
  profile: 'profiles',
  gallery_image: 'gallery_images',
  event: 'events',
  marketplace_listing: 'marketplace_listings',
};

function validTarget(req, res) {
  const targetType = req.params.targetType;
  const targetId = Number(req.params.targetId);
  if (!TARGET_TYPES.includes(targetType)) {
    res.status(400).json({ error: `targetType must be one of: ${TARGET_TYPES.join(', ')}` });
    return null;
  }
  if (!Number.isInteger(targetId)) {
    res.status(400).json({ error: 'A valid targetId is required.' });
    return null;
  }
  return { targetType, targetId };
}

async function targetExists(targetType, targetId) {
  const result = await pool.query(`SELECT 1 FROM ${TARGET_TABLE[targetType]} WHERE id = $1`, [targetId]);
  return result.rowCount > 0;
}

// GET /interactions/:targetType/:targetId/stats — public counts, no auth.
router.get('/:targetType/:targetId/stats', async (req, res, next) => {
  try {
    const target = validTarget(req, res);
    if (!target) return;
    const result = await pool.query('SELECT * FROM get_content_stats($1, $2)', [target.targetType, target.targetId]);
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// GET /interactions/:targetType/:targetId/mine — the signed-in member's
// own state on this item, so the frontend can render the Like/Dislike/
// Save buttons as active without a separate call per button.
router.get('/:targetType/:targetId/mine', requireAuth, async (req, res, next) => {
  try {
    const target = validTarget(req, res);
    if (!target) return;
    const [reaction, saved] = await Promise.all([
      pool.query(
        'SELECT reaction FROM content_reactions WHERE user_id = $1 AND target_type = $2 AND target_id = $3',
        [req.user.id, target.targetType, target.targetId]
      ),
      pool.query(
        'SELECT 1 FROM content_saves WHERE user_id = $1 AND target_type = $2 AND target_id = $3',
        [req.user.id, target.targetType, target.targetId]
      ),
    ]);
    res.json({
      reaction: reaction.rows[0] ? reaction.rows[0].reaction : null,
      saved: saved.rowCount > 0,
    });
  } catch (err) {
    next(err);
  }
});

// POST /interactions/:targetType/:targetId/react — body { reaction: 'like'|'dislike' }.
// Upserts, so switching from dislike to like (or vice versa) is one call,
// never both active at once by construction (single row, UNIQUE(user,
// target)).
router.post('/:targetType/:targetId/react', requireAuth, async (req, res, next) => {
  try {
    const target = validTarget(req, res);
    if (!target) return;
    const { reaction } = req.body;
    if (!['like', 'dislike'].includes(reaction)) {
      return res.status(400).json({ error: 'reaction must be "like" or "dislike".' });
    }
    if (!(await targetExists(target.targetType, target.targetId))) {
      return res.status(404).json({ error: 'That item no longer exists.' });
    }
    await pool.query(
      `INSERT INTO content_reactions (user_id, target_type, target_id, reaction)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, target_type, target_id) DO UPDATE SET reaction = $4, updated_at = now()`,
      [req.user.id, target.targetType, target.targetId, reaction]
    );
    res.status(201).json({ reaction });
  } catch (err) {
    next(err);
  }
});

// DELETE /interactions/:targetType/:targetId/react — removes any
// like/dislike (this IS the "unlike"/"undislike" action — clicking an
// already-active Like button calls this, not POST react again).
router.delete('/:targetType/:targetId/react', requireAuth, async (req, res, next) => {
  try {
    const target = validTarget(req, res);
    if (!target) return;
    await pool.query(
      'DELETE FROM content_reactions WHERE user_id = $1 AND target_type = $2 AND target_id = $3',
      [req.user.id, target.targetType, target.targetId]
    );
    res.json({ reaction: null });
  } catch (err) {
    next(err);
  }
});

// POST /interactions/:targetType/:targetId/save
router.post('/:targetType/:targetId/save', requireAuth, async (req, res, next) => {
  try {
    const target = validTarget(req, res);
    if (!target) return;
    if (!(await targetExists(target.targetType, target.targetId))) {
      return res.status(404).json({ error: 'That item no longer exists.' });
    }
    await pool.query(
      `INSERT INTO content_saves (user_id, target_type, target_id) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, target_type, target_id) DO NOTHING`,
      [req.user.id, target.targetType, target.targetId]
    );
    res.status(201).json({ saved: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /interactions/:targetType/:targetId/save
router.delete('/:targetType/:targetId/save', requireAuth, async (req, res, next) => {
  try {
    const target = validTarget(req, res);
    if (!target) return;
    await pool.query(
      'DELETE FROM content_saves WHERE user_id = $1 AND target_type = $2 AND target_id = $3',
      [req.user.id, target.targetType, target.targetId]
    );
    res.json({ saved: false });
  } catch (err) {
    next(err);
  }
});

// GET /interactions/saved/:targetType — the member's own saved list for
// one content type (replaces GET /saved for articles; generalised here
// so the same route covers every type).
router.get('/saved/:targetType', requireAuth, async (req, res, next) => {
  try {
    const targetType = req.params.targetType;
    if (!TARGET_TYPES.includes(targetType)) {
      return res.status(400).json({ error: `targetType must be one of: ${TARGET_TYPES.join(', ')}` });
    }
    const result = await pool.query(
      'SELECT target_id, saved_at FROM content_saves WHERE user_id = $1 AND target_type = $2 ORDER BY saved_at DESC',
      [req.user.id, targetType]
    );
    res.json({ saved: result.rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
