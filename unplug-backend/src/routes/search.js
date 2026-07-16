const express = require('express');
const pool = require('../db');

const router = express.Router();

// GET /search?q=term — public site-wide search across published articles,
// approved directory profiles, and editions. Case-insensitive substring
// match (ILIKE). Returns a small capped set per type for a quick overlay.
router.get('/', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 2) {
      return res.json({ query: q, results: { articles: [], profiles: [], editions: [] } });
    }
    const like = '%' + q + '%';

    const [articles, profiles, editions] = await Promise.all([
      pool.query(
        `SELECT id, title, kicker_supplied_by
         FROM articles
         WHERE status = 'approved' AND (title ILIKE $1 OR body ILIKE $1)
         ORDER BY published_at DESC NULLS LAST, created_at DESC
         LIMIT 8`,
        [like]
      ),
      pool.query(
        `SELECT id, slug, display_name, type, deaf_owned_verified
         FROM profiles
         WHERE status = 'approved' AND (display_name ILIKE $1 OR bio ILIKE $1)
         ORDER BY display_name ASC
         LIMIT 8`,
        [like]
      ),
      pool.query(
        `SELECT id, issue_number, title
         FROM editions
         WHERE title ILIKE $1
         ORDER BY issue_number DESC
         LIMIT 6`,
        [like]
      ),
    ]);

    res.json({
      query: q,
      results: {
        articles: articles.rows,
        profiles: profiles.rows,
        editions: editions.rows,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
