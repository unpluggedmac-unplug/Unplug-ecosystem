// Members, Profile Social Interaction & Community System — Phase 4:
// Follow / Unfollow System.

const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const { isCommunityFeatureEnabled } = require('../utils/communitySettings');
const { recordParticipationAsync } = require('../utils/participation');

const router = express.Router();

// POST /follows/:userId — follow. Following twice is a no-op (the SQL
// function itself is idempotent), so the button stays safe on a double
// tap or a retried request.
router.post('/:userId', requireAuth, async (req, res, next) => {
  try {
    const followedId = Number(req.params.userId);
    if (!Number.isInteger(followedId)) {
      return res.status(400).json({ error: 'A valid userId is required.' });
    }
    if (followedId === req.user.id) {
      return res.status(400).json({ error: 'You cannot follow yourself.' });
    }
    if (!(await isCommunityFeatureEnabled('community_follow_enabled'))) {
      return res.status(403).json({ error: 'Following is currently disabled.' });
    }
    const exists = await pool.query('SELECT 1 FROM users WHERE id = $1', [followedId]);
    if (exists.rowCount === 0) {
      return res.status(404).json({ error: 'That member no longer exists.' });
    }
    const result = await pool.query('SELECT follow_member($1, $2) AS followed', [req.user.id, followedId]);
    // Only on a NEW follow. Re-following someone you already follow is a
    // no-op, and scoring it would let a member farm points with one button.
    if (result.rows[0].followed) {
      recordParticipationAsync(req.user.id, 'member_follow', {
        contentType: 'profile', contentId: followedId, contentOwner: followedId,
      });
    }
    res.status(201).json({ following: true, wasAlreadyFollowing: !result.rows[0].followed });
  } catch (err) {
    next(err);
  }
});

// DELETE /follows/:userId — unfollow.
router.delete('/:userId', requireAuth, async (req, res, next) => {
  try {
    const followedId = Number(req.params.userId);
    if (!Number.isInteger(followedId)) {
      return res.status(400).json({ error: 'A valid userId is required.' });
    }
    if (!(await isCommunityFeatureEnabled('community_unfollow_enabled'))) {
      return res.status(403).json({ error: 'Unfollowing is currently disabled.' });
    }
    await pool.query('SELECT unfollow_member($1, $2)', [req.user.id, followedId]);
    res.json({ following: false });
  } catch (err) {
    next(err);
  }
});

// GET /follows/:userId/counts — public.
router.get('/:userId/counts', async (req, res, next) => {
  try {
    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId)) {
      return res.status(400).json({ error: 'A valid userId is required.' });
    }
    const result = await pool.query('SELECT * FROM get_follow_counts($1)', [userId]);
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// GET /follows/:userId/mine — auth. Whether the signed-in member follows
// this user, for rendering the Follow/Following button state.
router.get('/:userId/mine', requireAuth, async (req, res, next) => {
  try {
    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId)) {
      return res.status(400).json({ error: 'A valid userId is required.' });
    }
    const result = await pool.query(
      'SELECT 1 FROM member_follows WHERE follower_user_id = $1 AND followed_user_id = $2',
      [req.user.id, userId]
    );
    res.json({ following: result.rowCount > 0 });
  } catch (err) {
    next(err);
  }
});

// Display name helper — same COALESCE(display_name, email local-part)
// pattern used throughout this codebase (comments.js, interactions.js).
const PUBLIC_MEMBER_SQL = `
  u.id AS user_id,
  COALESCE(pr.display_name, SPLIT_PART(u.email, '@', 1)) AS display_name,
  pr.feature_image_url AS avatar_url,
  pr.type AS profile_type`;

// GET /follows/:userId/followers — public, paginated, newest first.
router.get('/:userId/followers', async (req, res, next) => {
  try {
    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId)) {
      return res.status(400).json({ error: 'A valid userId is required.' });
    }
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const result = await pool.query(
      `SELECT ${PUBLIC_MEMBER_SQL}, mf.created_at AS followed_at
         FROM member_follows mf
         JOIN users u ON u.id = mf.follower_user_id
         LEFT JOIN profiles pr ON pr.user_id = u.id AND pr.status = 'approved'
        WHERE mf.followed_user_id = $1
        ORDER BY mf.created_at DESC
        LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );
    res.json({ followers: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /follows/:userId/following — public, paginated, newest first.
router.get('/:userId/following', async (req, res, next) => {
  try {
    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId)) {
      return res.status(400).json({ error: 'A valid userId is required.' });
    }
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const result = await pool.query(
      `SELECT ${PUBLIC_MEMBER_SQL}, mf.created_at AS followed_at
         FROM member_follows mf
         JOIN users u ON u.id = mf.followed_user_id
         LEFT JOIN profiles pr ON pr.user_id = u.id AND pr.status = 'approved'
        WHERE mf.follower_user_id = $1
        ORDER BY mf.created_at DESC
        LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );
    res.json({ following: result.rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
