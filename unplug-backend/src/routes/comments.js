const express = require('express');
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logActivity } = require('./activityLog');
const { publicSubmitLimiter } = require('../middleware/rateLimit');
const honeypot = require('../middleware/honeypot');
const { notifyProfileOwner } = require('./interactions');

const router = express.Router();

const MAX_COMMENT_LENGTH = 2000;
const VALID_REACTIONS = ['like', 'love', 'clap', 'insightful'];
// Members, Profile Social Interaction & Community System Phase 2 —
// comments generalised from articles-only to every content type the
// universal interaction engine (Phase 1) already covers.
const TARGET_TYPES = ['article', 'profile', 'gallery_image', 'event', 'marketplace_listing'];
const TARGET_TABLE = {
  article: 'articles',
  profile: 'profiles',
  gallery_image: 'gallery_images',
  event: 'events',
  marketplace_listing: 'marketplace_listings',
};

// Email addresses are never exposed publicly — readers see the part before
// the @ as a display name. Members who set a display name on a profile get
// that instead. This is a scalar subquery rather than a join because one
// member can own several profiles, and a join would duplicate every comment.
const PUBLIC_AUTHOR_SQL = `
  COALESCE(
    NULLIF((SELECT pr.display_name FROM profiles pr
             WHERE pr.user_id = c.user_id ORDER BY pr.id LIMIT 1), ''),
    split_part(u.email, '@', 1)
  ) AS author`;

// GET /comments/:targetType/:targetId — public. Approved comments only,
// with reaction tallies, oldest first so a thread reads top to bottom.
// The URL shape (e.g. /comments/article/12) is unchanged from before
// this generalisation — 'article' was always the first path segment, it
// just used to be hardcoded rather than validated against a list.
router.get('/:targetType/:targetId', async (req, res, next) => {
  try {
    const { targetType } = req.params;
    const targetId = Number(req.params.targetId);
    if (!TARGET_TYPES.includes(targetType)) {
      return res.status(400).json({ error: `targetType must be one of: ${TARGET_TYPES.join(', ')}` });
    }
    if (!Number.isInteger(targetId)) {
      return res.status(400).json({ error: 'A valid id is required.' });
    }
    const result = await pool.query(
      `SELECT c.id, c.body, c.created_at, ${PUBLIC_AUTHOR_SQL},
              COUNT(r.user_id) FILTER (WHERE r.reaction = 'like')       AS like_count,
              COUNT(r.user_id) FILTER (WHERE r.reaction = 'love')       AS love_count,
              COUNT(r.user_id) FILTER (WHERE r.reaction = 'clap')       AS clap_count,
              COUNT(r.user_id) FILTER (WHERE r.reaction = 'insightful') AS insightful_count
         FROM content_comments c
         JOIN users u ON u.id = c.user_id
         LEFT JOIN content_comment_reactions r ON r.comment_id = c.id
        WHERE c.target_type = $1 AND c.target_id = $2 AND c.status = 'approved'
        GROUP BY c.id, c.user_id, u.email
        ORDER BY c.created_at ASC`,
      [targetType, targetId]
    );
    res.json({ comments: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /comments/:targetType/:targetId — members only. Lands in the
// moderation queue; we tell the commenter that plainly rather than
// implying it's live.
router.post('/:targetType/:targetId', requireAuth, publicSubmitLimiter, honeypot, async (req, res, next) => {
  try {
    const { targetType } = req.params;
    const targetId = Number(req.params.targetId);
    if (!TARGET_TYPES.includes(targetType)) {
      return res.status(400).json({ error: `targetType must be one of: ${TARGET_TYPES.join(', ')}` });
    }
    if (!Number.isInteger(targetId)) {
      return res.status(400).json({ error: 'A valid id is required.' });
    }
    const body = (req.body.body || '').trim();
    if (!body) {
      return res.status(400).json({ error: 'Write something before posting.' });
    }
    if (body.length > MAX_COMMENT_LENGTH) {
      return res.status(400).json({ error: `Comments are limited to ${MAX_COMMENT_LENGTH} characters.` });
    }
    const target = await pool.query(`SELECT 1 FROM ${TARGET_TABLE[targetType]} WHERE id = $1`, [targetId]);
    if (target.rowCount === 0) {
      return res.status(404).json({ error: 'That item no longer exists.' });
    }
    const result = await pool.query(
      `INSERT INTO content_comments (target_type, target_id, user_id, body)
       VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
      [targetType, targetId, req.user.id, body]
    );
    res.status(201).json({
      comment: result.rows[0],
      message: 'Thanks — your comment has been sent for review and will appear once approved.',
    });
  } catch (err) {
    next(err);
  }
});

// POST /comments/:id/react — members only. Sending the same reaction again
// clears it (a toggle); a different one replaces it.
router.post('/:id/react', requireAuth, async (req, res, next) => {
  try {
    const commentId = Number(req.params.id);
    const reaction = (req.body.reaction || '').trim();
    if (!Number.isInteger(commentId)) {
      return res.status(400).json({ error: 'A valid comment id is required.' });
    }
    if (!VALID_REACTIONS.includes(reaction)) {
      return res.status(400).json({ error: 'That reaction is not available.' });
    }
    // Only approved comments are reactable — nothing in the queue is public.
    const comment = await pool.query(
      "SELECT 1 FROM content_comments WHERE id = $1 AND status = 'approved'",
      [commentId]
    );
    if (comment.rowCount === 0) {
      return res.status(404).json({ error: 'That comment is not available.' });
    }
    const existing = await pool.query(
      'SELECT reaction FROM content_comment_reactions WHERE comment_id = $1 AND user_id = $2',
      [commentId, req.user.id]
    );
    if (existing.rowCount > 0 && existing.rows[0].reaction === reaction) {
      await pool.query(
        'DELETE FROM content_comment_reactions WHERE comment_id = $1 AND user_id = $2',
        [commentId, req.user.id]
      );
      return res.json({ reaction: null });
    }
    await pool.query(
      `INSERT INTO content_comment_reactions (comment_id, user_id, reaction)
       VALUES ($1, $2, $3)
       ON CONFLICT (comment_id, user_id) DO UPDATE SET reaction = EXCLUDED.reaction`,
      [commentId, req.user.id, reaction]
    );
    res.json({ reaction });
  } catch (err) {
    next(err);
  }
});

// GET /comments/pending — admin moderation queue across every content
// type, oldest first so nothing waits indefinitely behind newer comments.
router.get('/pending', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT c.id, c.body, c.created_at, c.target_type, c.target_id,
              get_target_title(c.target_type, c.target_id) AS target_title,
              u.email AS author_email, ${PUBLIC_AUTHOR_SQL}
         FROM content_comments c
         JOIN users u ON u.id = c.user_id
        WHERE c.status = 'pending'
        ORDER BY c.created_at ASC`
    );
    res.json({ comments: result.rows });
  } catch (err) {
    next(err);
  }
});

// PATCH /comments/:id/status — admin approves or rejects.
router.patch('/:id/status', requireRole('admin'), async (req, res, next) => {
  try {
    const commentId = Number(req.params.id);
    const status = (req.body.status || '').trim();
    if (!Number.isInteger(commentId)) {
      return res.status(400).json({ error: 'A valid comment id is required.' });
    }
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: "Status must be 'approved' or 'rejected'." });
    }
    const result = await pool.query(
      `UPDATE content_comments SET status = $1, reviewed_at = now()
        WHERE id = $2 RETURNING id, status, user_id, target_type, target_id`,
      [status, commentId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'That comment no longer exists.' });
    }
    logActivity(req.user.id, 'comment_' + status, `comment ${commentId}`);
    // A comment only became real (publicly visible) just now — that's the
    // moment to notify a profile owner, not at submission, when it might
    // still be rejected.
    if (status === 'approved') {
      const c = result.rows[0];
      try { await notifyProfileOwner(c.user_id, c.target_type, c.target_id, '💬', 'commented on'); } catch (e) { /* notification failure must never block approval */ }
    }
    res.json({ comment: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /comments/:id — the comment's author can withdraw their own; admins
// can remove any.
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const commentId = Number(req.params.id);
    if (!Number.isInteger(commentId)) {
      return res.status(400).json({ error: 'A valid comment id is required.' });
    }
    const owner = await pool.query('SELECT user_id FROM content_comments WHERE id = $1', [commentId]);
    if (owner.rowCount === 0) {
      return res.status(404).json({ error: 'That comment no longer exists.' });
    }
    if (owner.rows[0].user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'You can only remove your own comments.' });
    }
    await pool.query('DELETE FROM content_comments WHERE id = $1', [commentId]);
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
