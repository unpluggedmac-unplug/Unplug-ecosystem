const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /feed/topics — the news categories a member can follow, each flagged
// with whether they already follow it.
router.get('/topics', requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT c.id, c.name,
              (f.user_id IS NOT NULL) AS following
         FROM categories c
         LEFT JOIN followed_topics f
           ON f.category_id = c.id AND f.user_id = $1
        WHERE c.type = 'news'
        ORDER BY c.name`,
      [req.user.id]
    );
    res.json({ topics: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /feed/topics/:categoryId — follow. Idempotent, so the toggle can't
// get stuck out of sync with a double tap.
router.post('/topics/:categoryId', requireAuth, async (req, res, next) => {
  try {
    const categoryId = Number(req.params.categoryId);
    if (!Number.isInteger(categoryId)) {
      return res.status(400).json({ error: 'A valid topic is required.' });
    }
    const exists = await pool.query("SELECT 1 FROM categories WHERE id = $1 AND type = 'news'", [categoryId]);
    if (exists.rowCount === 0) {
      return res.status(404).json({ error: 'That topic no longer exists.' });
    }
    await pool.query(
      `INSERT INTO followed_topics (user_id, category_id) VALUES ($1, $2)
       ON CONFLICT (user_id, category_id) DO NOTHING`,
      [req.user.id, categoryId]
    );
    res.status(201).json({ following: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /feed/topics/:categoryId — unfollow.
router.delete('/topics/:categoryId', requireAuth, async (req, res, next) => {
  try {
    const categoryId = Number(req.params.categoryId);
    if (!Number.isInteger(categoryId)) {
      return res.status(400).json({ error: 'A valid topic is required.' });
    }
    await pool.query(
      'DELETE FROM followed_topics WHERE user_id = $1 AND category_id = $2',
      [req.user.id, categoryId]
    );
    res.json({ following: false });
  } catch (err) {
    next(err);
  }
});

// GET /feed/for-you — a personalised feed.
//
// Signal, strongest first:
//   2 = the topic is explicitly followed
//   1 = the member has saved something from that category before
//   0 = everything else (so the feed is never empty for a new member)
//
// Already-saved articles are excluded — the reading list covers those.
router.get('/for-you', requireAuth, async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 12, 40);
    const result = await pool.query(
      `WITH followed AS (
         SELECT category_id FROM followed_topics WHERE user_id = $1
       ), saved_cats AS (
         SELECT DISTINCT a.category_id
           FROM saved_articles s
           JOIN articles a ON a.id = s.article_id
          WHERE s.user_id = $1 AND a.category_id IS NOT NULL
       )
       SELECT a.id, a.title, a.body, a.kicker_supplied_by, a.emotion,
              a.published_at, c.name AS category,
              CASE
                WHEN a.category_id IN (SELECT category_id FROM followed)    THEN 2
                WHEN a.category_id IN (SELECT category_id FROM saved_cats)  THEN 1
                ELSE 0
              END AS score
         FROM articles a
         LEFT JOIN categories c ON c.id = a.category_id
        WHERE a.status = 'approved'
          AND a.id NOT IN (SELECT article_id FROM saved_articles WHERE user_id = $1)
        ORDER BY score DESC, a.published_at DESC NULLS LAST, a.id DESC
        LIMIT $2`,
      [req.user.id, limit]
    );
    // personalised tells the frontend whether to say "For you" or fall back
    // to a plain "Latest stories" heading — claiming personalisation when
    // there's no signal behind it would be a lie.
    const personalised = result.rows.some((r) => r.score > 0);
    res.json({ articles: result.rows, personalised });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
