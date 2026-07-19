const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Every route here is personal to the signed-in member — the user id always
// comes from the verified token, never from the request body, so one member
// can't read or change another's reading list.

// GET /saved — the member's reading list, newest save first.
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      // Category lives on the categories table, not on articles — articles
      // only carries category_id.
      `SELECT a.id, a.title, c.name AS category, a.body, a.created_at, s.saved_at
         FROM saved_articles s
         JOIN articles a ON a.id = s.article_id
         LEFT JOIN categories c ON c.id = a.category_id
        WHERE s.user_id = $1
        ORDER BY s.saved_at DESC`,
      [req.user.id]
    );
    res.json({ saved: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /saved/ids — just the ids, so the frontend can mark "Saved" on cards
// without shipping every article body down the wire.
router.get('/ids', requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT article_id FROM saved_articles WHERE user_id = $1',
      [req.user.id]
    );
    res.json({ ids: result.rows.map((r) => r.article_id) });
  } catch (err) {
    next(err);
  }
});

// POST /saved/:articleId — save. Saving twice is a no-op (ON CONFLICT), so
// the button stays idempotent even on a double tap or a retried request.
router.post('/:articleId', requireAuth, async (req, res, next) => {
  try {
    const articleId = Number(req.params.articleId);
    if (!Number.isInteger(articleId)) {
      return res.status(400).json({ error: 'A valid article id is required.' });
    }
    const exists = await pool.query('SELECT 1 FROM articles WHERE id = $1', [articleId]);
    if (exists.rowCount === 0) {
      return res.status(404).json({ error: 'That article no longer exists.' });
    }
    await pool.query(
      `INSERT INTO saved_articles (user_id, article_id) VALUES ($1, $2)
       ON CONFLICT (user_id, article_id) DO NOTHING`,
      [req.user.id, articleId]
    );
    res.status(201).json({ saved: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /saved/:articleId — remove from the list. Deleting something that
// isn't saved is also fine, so the toggle can't get stuck out of sync.
router.delete('/:articleId', requireAuth, async (req, res, next) => {
  try {
    const articleId = Number(req.params.articleId);
    if (!Number.isInteger(articleId)) {
      return res.status(400).json({ error: 'A valid article id is required.' });
    }
    await pool.query(
      'DELETE FROM saved_articles WHERE user_id = $1 AND article_id = $2',
      [req.user.id, articleId]
    );
    res.json({ saved: false });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
