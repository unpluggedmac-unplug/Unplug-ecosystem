const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /highlights/active — public. Used by the homepage/article/directory
// pages to know what's currently boosted and should render with the
// "Highlighted" badge.
router.get('/active', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, target_type, target_id, start_date, end_date
       FROM highlights
       WHERE status = 'approved'
         AND start_date <= CURRENT_DATE
         AND end_date >= CURRENT_DATE`
    );
    res.json({ highlights: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /highlights — member requests a highlight on their own article or
// Directory profile. Ownership of the target is checked inline below.
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { targetType, targetId, durationDays } = req.body;
    if (!['article', 'directory'].includes(targetType)) {
      return res.status(400).json({ error: 'targetType must be "article" or "directory".' });
    }
    if (![7, 14, 21, 28].includes(durationDays)) {
      return res.status(400).json({ error: 'durationDays must be one of: 7, 14, 21, 28.' });
    }

    const ownerTable = targetType === 'article' ? 'articles' : 'profiles';
    const ownerColumn = targetType === 'article' ? 'author_user_id' : 'user_id';
    const ownerCheck = await pool.query(`SELECT ${ownerColumn} AS owner_id FROM ${ownerTable} WHERE id = $1`, [targetId]);
    if (ownerCheck.rows.length === 0) {
      return res.status(404).json({ error: `${targetType} not found.` });
    }
    if (ownerCheck.rows[0].owner_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'You can only highlight your own content.' });
    }

    const result = await pool.query(
      `INSERT INTO highlights (target_type, target_id, duration_days)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [targetType, targetId, durationDays]
    );

    res.status(201).json({
      highlight: result.rows[0],
      message: 'Highlight request created — call POST /payments/initiate with linkedType "highlight" and this highlight\'s id to proceed.',
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
