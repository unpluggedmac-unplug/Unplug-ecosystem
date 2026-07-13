const express = require('express');
const pool = require('../db');
const { requireAuth, requireOwnerOrAdmin } = require('../middleware/auth');
const { getPagination, paginationMeta } = require('../utils/pagination');

const router = express.Router();

async function getArticleOwnerId(req) {
  const result = await pool.query('SELECT author_user_id FROM articles WHERE id = $1', [req.params.id]);
  if (result.rows.length === 0) return null;
  return result.rows[0].author_user_id;
}

// GET /articles?category= — public, published only.
router.get('/', async (req, res, next) => {
  try {
    const { category } = req.query;
    const conditions = [`a.status = 'approved'`];
    const values = [];
    if (category) {
      values.push(category);
      conditions.push(`c.name = $${values.length}`);
    }

    const { page, limit, offset } = getPagination(req);

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM articles a
       LEFT JOIN categories c ON c.id = a.category_id
       WHERE ${conditions.join(' AND ')}`,
      values
    );

    const result = await pool.query(
      `SELECT a.id, a.title, a.body, a.kicker_supplied_by, a.published_at, c.name AS category
       FROM articles a
       LEFT JOIN categories c ON c.id = a.category_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY a.published_at DESC NULLS LAST, a.created_at DESC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset]
    );
    res.json({
      articles: result.rows,
      pagination: paginationMeta(page, limit, parseInt(countResult.rows[0].count, 10)),
    });
  } catch (err) {
    next(err);
  }
});

// GET /articles/mine — the authenticated member's own articles, at any
// status (draft/pending/approved/rejected) — not just published ones.
router.get('/mine', requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT a.*, c.name AS category
       FROM articles a
       LEFT JOIN categories c ON c.id = a.category_id
       WHERE a.author_user_id = $1
       ORDER BY a.created_at DESC`,
      [req.user.id]
    );
    res.json({ articles: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /articles/:id — public, published only.
router.get('/:id', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT a.*, c.name AS category
       FROM articles a
       LEFT JOIN categories c ON c.id = a.category_id
       WHERE a.id = $1 AND a.status = 'approved'`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Article not found.' });
    }
    res.json({ article: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// POST /articles — member submits (enters as 'pending').
// kickerSuppliedBy is the "Supplied by [Name Surname]" byline confirmed
// earlier for the Latest News page.
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { title, body, categoryId, kickerSuppliedBy, bannerImageUrl } = req.body;
    if (!title || !body) {
      return res.status(400).json({ error: 'title and body are required.' });
    }

    const profileResult = await pool.query(
      'SELECT id, free_article_credits FROM profiles WHERE user_id = $1',
      [req.user.id]
    );
    const hasCredit = profileResult.rows.length > 0 && profileResult.rows[0].free_article_credits > 0;

    const result = await pool.query(
      `INSERT INTO articles (author_user_id, category_id, title, body, kicker_supplied_by, banner_image_url, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [req.user.id, categoryId || null, title, body, kickerSuppliedBy || null, bannerImageUrl || null, hasCredit ? 'pending' : 'awaiting_payment']
    );

    if (hasCredit) {
      await pool.query('UPDATE profiles SET free_article_credits = free_article_credits - 1 WHERE id = $1', [profileResult.rows[0].id]);
    }

    res.status(201).json({
      article: result.rows[0],
      message: hasCredit
        ? 'Article created using your free Article credit — submitted for approval, no payment needed.'
        : 'Article created — call POST /payments/initiate with linkedType "article_publish" and this article\'s id (R95.00) to submit it for approval.',
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /articles/:id — owner or admin can edit before/after approval.
router.patch('/:id', requireOwnerOrAdmin(getArticleOwnerId), async (req, res, next) => {
  try {
    const { title, body, kickerSuppliedBy } = req.body;
    const setClauses = [];
    const values = [];

    if (title !== undefined) { values.push(title); setClauses.push(`title = $${values.length}`); }
    if (body !== undefined) { values.push(body); setClauses.push(`body = $${values.length}`); }
    if (kickerSuppliedBy !== undefined) { values.push(kickerSuppliedBy); setClauses.push(`kicker_supplied_by = $${values.length}`); }

    if (setClauses.length === 0) {
      return res.status(400).json({ error: 'No editable fields provided.' });
    }
    values.push(req.params.id);

    const result = await pool.query(
      `UPDATE articles SET ${setClauses.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Article not found.' });
    }
    res.json({ article: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
