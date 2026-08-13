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
const { isCommunityFeatureEnabled } = require('../utils/communitySettings');
const { recordParticipationAsync } = require('../utils/participation');

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

// Members/Community System Phase 7 — profile-interaction notifications.
// Only profile targets notify (an article/gallery/event/marketplace like
// has no "owner" in the same personal sense this brief means), and never
// when the actor is the profile's own owner. One shared 'profile_interaction'
// notification type covers like/dislike/save/comment/review, same as
// 'status_change' already covers both promotion and demotion — title text
// carries the distinction, not a proliferation of near-duplicate types.
async function notifyProfileOwner(actorUserId, targetType, targetId, emoji, verb) {
  if (targetType !== 'profile') return;
  if (!(await isCommunityFeatureEnabled('notify_profile_interaction_enabled'))) return;
  const owner = await pool.query('SELECT user_id FROM profiles WHERE id = $1', [targetId]);
  if (!owner.rows.length || owner.rows[0].user_id === actorUserId) return;
  const actorName = await pool.query(
    `SELECT COALESCE(pr.display_name, SPLIT_PART(u.email, '@', 1)) AS name
       FROM users u LEFT JOIN profiles pr ON pr.user_id = u.id
      WHERE u.id = $1`,
    [actorUserId]
  );
  const name = actorName.rows[0] ? actorName.rows[0].name : 'Someone';
  await pool.query(
    `INSERT INTO notifications (user_id, type, title, body, link_url)
     VALUES ($1, 'profile_interaction', $2, $3, '/unplug-member-dashboard.html')`,
    [owner.rows[0].user_id, `${emoji} Profile activity`, `${name} ${verb} your profile.`]
  );
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

// POST /interactions/:targetType/:targetId/view — records that someone
// looked at an item. Deliberately NOT auth-gated: most viewers of a public
// gallery are signed out, and a view count that only counted members would
// be wrong rather than merely incomplete.
//
// Guests are identified by the sessionId the frontend already generates for
// anonymous voting. Deduped to one per viewer per day by a unique index
// (103_content_views.sql), so ON CONFLICT DO NOTHING makes a refresh a
// no-op instead of an error.
router.post('/:targetType/:targetId/view', async (req, res, next) => {
  try {
    const target = validTarget(req, res);
    if (!target) return;
    const { targetType, targetId } = target;

    const sessionId = String(req.body.sessionId || '').trim().slice(0, 120) || null;
    if (!req.user && !sessionId) {
      return res.status(400).json({ error: 'sessionId is required for guest views.' });
    }
    if (!(await targetExists(targetType, targetId))) {
      return res.status(404).json({ error: 'That item no longer exists.' });
    }

    await pool.query(
      `INSERT INTO content_views (target_type, target_id, user_id, session_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [targetType, targetId, req.user ? req.user.id : null, req.user ? null : sessionId]
    );
    // Discovering someone or something is a real participation action, but
    // only for a signed-in member and only for the three target types the
    // mission programme actually asks about. Capped at 10/day per action by
    // the engine, so scrolling a list cannot be farmed.
    const DISCOVERY_ACTION = {
      profile: 'member_discover',
      marketplace_listing: 'marketplace_discover',
    };
    if (req.user) {
      // A business and a member are both `profile` rows; the type tells them
      // apart, so a business view is credited as a business discovery.
      let action = DISCOVERY_ACTION[targetType];
      if (targetType === 'profile') {
        const kind = await pool.query('SELECT type FROM profiles WHERE id = $1', [targetId]);
        if (kind.rows[0] && kind.rows[0].type === 'business') action = 'business_discover';
      }
      if (action) recordParticipationAsync(req.user.id, action, { contentType: targetType, contentId: targetId });
    }

    // The caller only needs the new total to repaint; whether THIS request
    // was the one that counted is not interesting to it.
    const stats = await pool.query('SELECT views FROM get_content_stats($1, $2)', [targetType, targetId]);
    res.json({ views: stats.rows[0].views });
  } catch (err) {
    next(err);
  }
});

// GET /interactions/:targetType/batch-stats?ids=1,2,3 — public counts for
// many items in one call, so a grid of cards (gallery, marketplace, news)
// doesn't fire one /stats request per card.
router.get('/:targetType/batch-stats', async (req, res, next) => {
  try {
    const targetType = req.params.targetType;
    if (!TARGET_TYPES.includes(targetType)) {
      return res.status(400).json({ error: `targetType must be one of: ${TARGET_TYPES.join(', ')}` });
    }
    const ids = String(req.query.ids || '').split(',').map((s) => s.trim()).filter(Boolean).map(Number).filter(Number.isInteger);
    if (!ids.length) return res.json({ stats: {} });
    const result = await pool.query(
      `SELECT t.id AS target_id, s.likes, s.dislikes, s.comments, s.saves, s.views
         FROM unnest($1::int[]) AS t(id)
         CROSS JOIN LATERAL get_content_stats($2, t.id) AS s`,
      [ids, targetType]
    );
    const stats = {};
    result.rows.forEach((r) => { stats[r.target_id] = { likes: r.likes, dislikes: r.dislikes, comments: r.comments, saves: r.saves, views: r.views }; });
    res.json({ stats });
  } catch (err) {
    next(err);
  }
});

// GET /interactions/:targetType/batch-mine?ids=1,2,3 — the signed-in
// member's own reaction/save state across many items in one call.
router.get('/:targetType/batch-mine', requireAuth, async (req, res, next) => {
  try {
    const targetType = req.params.targetType;
    if (!TARGET_TYPES.includes(targetType)) {
      return res.status(400).json({ error: `targetType must be one of: ${TARGET_TYPES.join(', ')}` });
    }
    const ids = String(req.query.ids || '').split(',').map((s) => s.trim()).filter(Boolean).map(Number).filter(Number.isInteger);
    if (!ids.length) return res.json({ mine: {} });
    const [reactions, saves] = await Promise.all([
      pool.query(
        'SELECT target_id, reaction FROM content_reactions WHERE user_id = $1 AND target_type = $2 AND target_id = ANY($3::int[])',
        [req.user.id, targetType, ids]
      ),
      pool.query(
        'SELECT target_id FROM content_saves WHERE user_id = $1 AND target_type = $2 AND target_id = ANY($3::int[])',
        [req.user.id, targetType, ids]
      ),
    ]);
    const mine = {};
    ids.forEach((id) => { mine[id] = { reaction: null, saved: false }; });
    reactions.rows.forEach((r) => { mine[r.target_id].reaction = r.reaction; });
    saves.rows.forEach((r) => { mine[r.target_id].saved = true; });
    res.json({ mine });
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
    if (!(await isCommunityFeatureEnabled(reaction === 'like' ? 'community_likes_enabled' : 'community_dislikes_enabled'))) {
      return res.status(403).json({ error: `${reaction === 'like' ? 'Likes' : 'Dislikes'} are currently disabled.` });
    }
    if (!(await targetExists(target.targetType, target.targetId))) {
      return res.status(404).json({ error: 'That item no longer exists.' });
    }
    // Checked before the upsert so a notification only fires on a
    // genuinely new reaction — a member toggling like<->dislike back and
    // forth on the same profile must not spam its owner every time.
    const existing = await pool.query(
      'SELECT 1 FROM content_reactions WHERE user_id = $1 AND target_type = $2 AND target_id = $3',
      [req.user.id, target.targetType, target.targetId]
    );
    await pool.query(
      `INSERT INTO content_reactions (user_id, target_type, target_id, reaction)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, target_type, target_id) DO UPDATE SET reaction = $4, updated_at = now()`,
      [req.user.id, target.targetType, target.targetId, reaction]
    );
    if (existing.rowCount === 0) {
      try { await notifyProfileOwner(req.user.id, target.targetType, target.targetId, reaction === 'like' ? '❤️' : '👎', reaction + 'd'); } catch (e) { /* notification failure must never block the reaction itself */ }
      // First reaction on this item only — switching like to dislike and back
      // must not pay twice.
      if (reaction === 'like') {
        recordParticipationAsync(req.user.id, 'like_content', {
          contentType: target.targetType, contentId: target.targetId,
        });
      }
    }
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
    if (!(await isCommunityFeatureEnabled('community_saves_enabled'))) {
      return res.status(403).json({ error: 'Saves are currently disabled.' });
    }
    if (!(await targetExists(target.targetType, target.targetId))) {
      return res.status(404).json({ error: 'That item no longer exists.' });
    }
    const inserted = await pool.query(
      `INSERT INTO content_saves (user_id, target_type, target_id) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, target_type, target_id) DO NOTHING RETURNING 1`,
      [req.user.id, target.targetType, target.targetId]
    );
    if (inserted.rowCount > 0) {
      try { await notifyProfileOwner(req.user.id, target.targetType, target.targetId, '🔖', 'saved'); } catch (e) { /* notification failure must never block the save itself */ }
      // rowCount > 0 means it was not already saved, so unsaving and saving
      // the same item repeatedly cannot be used to earn.
      recordParticipationAsync(req.user.id, 'save_content', {
        contentType: target.targetType, contentId: target.targetId,
      });
    }
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

// Attached to the router function itself (not a separate export shape)
// so app.js's existing `app.use('/interactions', require('./interactions'))`
// keeps working unchanged, while comments.js/reviews.js can still pull in
// notifyProfileOwner via `const { notifyProfileOwner } = require('./interactions')`.
router.notifyProfileOwner = notifyProfileOwner;
module.exports = router;
