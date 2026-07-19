const express = require('express');
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logActivity } = require('./activityLog');
const { publicSubmitLimiter } = require('../middleware/rateLimit');
const honeypot = require('../middleware/honeypot');

const router = express.Router();

const MAX_COMMENT_LENGTH = 2000;
const VALID_REACTIONS = ['like', 'love', 'clap', 'insightful'];

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

// GET /comments/article/:articleId — public. Approved comments only, with
// reaction tallies, oldest first so a thread reads top to bottom.
router.get('/article/:articleId', async (req, res, next) => {
  try {
    const articleId = Number(req.params.articleId);
    if (!Number.isInteger(articleId)) {
      return res.status(400).json({ error: 'A valid article id is required.' });
    }
    const result = await pool.query(
      `SELECT c.id, c.body, c.created_at, ${PUBLIC_AUTHOR_SQL},
              COUNT(r.user_id) FILTER (WHERE r.reaction = 'like')       AS like_count,
              COUNT(r.user_id) FILTER (WHERE r.reaction = 'love')       AS love_count,
              COUNT(r.user_id) FILTER (WHERE r.reaction = 'clap')       AS clap_count,
              COUNT(r.user_id) FILTER (WHERE r.reaction = 'insightful') AS insightful_count
         FROM article_comments c
         JOIN users u ON u.id = c.user_id
         LEFT JOIN article_comment_reactions r ON r.comment_id = c.id
        WHERE c.article_id = $1 AND c.status = 'approved'
        GROUP BY c.id, c.user_id, u.email
        ORDER BY c.created_at ASC`,
      [articleId]
    );
    res.json({ comments: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /comments/article/:articleId — members only. Lands in the moderation
// queue; we tell the commenter that plainly rather than implying it's live.
router.post('/article/:articleId', requireAuth, publicSubmitLimiter, honeypot, async (req, res, next) => {
  try {
    const articleId = Number(req.params.articleId);
    if (!Number.isInteger(articleId)) {
      return res.status(400).json({ error: 'A valid article id is required.' });
    }
    const body = (req.body.body || '').trim();
    if (!body) {
      return res.status(400).json({ error: 'Write something before posting.' });
    }
    if (body.length > MAX_COMMENT_LENGTH) {
      return res.status(400).json({ error: `Comments are limited to ${MAX_COMMENT_LENGTH} characters.` });
    }
    const article = await pool.query('SELECT 1 FROM articles WHERE id = $1', [articleId]);
    if (article.rowCount === 0) {
      return res.status(404).json({ error: 'That article no longer exists.' });
    }
    const result = await pool.query(
      `INSERT INTO article_comments (article_id, user_id, body)
       VALUES ($1, $2, $3) RETURNING id, created_at`,
      [articleId, req.user.id, body]
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
      "SELECT 1 FROM article_comments WHERE id = $1 AND status = 'approved'",
      [commentId]
    );
    if (comment.rowCount === 0) {
      return res.status(404).json({ error: 'That comment is not available.' });
    }
    const existing = await pool.query(
      'SELECT reaction FROM article_comment_reactions WHERE comment_id = $1 AND user_id = $2',
      [commentId, req.user.id]
    );
    if (existing.rowCount > 0 && existing.rows[0].reaction === reaction) {
      await pool.query(
        'DELETE FROM article_comment_reactions WHERE comment_id = $1 AND user_id = $2',
        [commentId, req.user.id]
      );
      return res.json({ reaction: null });
    }
    await pool.query(
      `INSERT INTO article_comment_reactions (comment_id, user_id, reaction)
       VALUES ($1, $2, $3)
       ON CONFLICT (comment_id, user_id) DO UPDATE SET reaction = EXCLUDED.reaction`,
      [commentId, req.user.id, reaction]
    );
    res.json({ reaction });
  } catch (err) {
    next(err);
  }
});

// GET /comments/pending — admin moderation queue, oldest first so nothing
// waits indefinitely behind newer comments.
router.get('/pending', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT c.id, c.body, c.created_at, c.article_id, a.title AS article_title,
              u.email AS author_email, ${PUBLIC_AUTHOR_SQL}
         FROM article_comments c
         JOIN users u ON u.id = c.user_id
         JOIN articles a ON a.id = c.article_id
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
      `UPDATE article_comments SET status = $1, reviewed_at = now()
        WHERE id = $2 RETURNING id, status`,
      [status, commentId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'That comment no longer exists.' });
    }
    logActivity(req.user.id, 'comment_' + status, `comment ${commentId}`);
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
    const owner = await pool.query('SELECT user_id FROM article_comments WHERE id = $1', [commentId]);
    if (owner.rowCount === 0) {
      return res.status(404).json({ error: 'That comment no longer exists.' });
    }
    if (owner.rows[0].user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'You can only remove your own comments.' });
    }
    await pool.query('DELETE FROM article_comments WHERE id = $1', [commentId]);
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
