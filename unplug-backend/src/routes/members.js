// Members, Profile Social Interaction & Community System — Phase 5:
// the Members page.

const express = require('express');
const pool = require('../db');

const router = express.Router();

const VALID_SORTS = ['trending', 'newest', 'most_followed', 'highest_ranked', 'featured', 'random'];
const VALID_TYPES = ['individual', 'business'];

// GET /members?search=&category=&province=&type=&sort=&limit=&offset=
// Public, infinite-scroll friendly (limit/offset). Backs the Members
// grid, its search box, and every filter tab the brief asks for.
router.get('/', async (req, res, next) => {
  try {
    const search = req.query.search ? String(req.query.search).trim().slice(0, 100) : null;
    const category = req.query.category ? Number(req.query.category) : null;
    const province = req.query.province ? String(req.query.province).trim() : null;
    const type = VALID_TYPES.includes(req.query.type) ? req.query.type : null;
    const sort = VALID_SORTS.includes(req.query.sort) ? req.query.sort : 'newest';
    const limit = Math.min(Number(req.query.limit) || 24, 60);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    if (category !== null && !Number.isInteger(category)) {
      return res.status(400).json({ error: 'category must be a valid id.' });
    }

    const result = await pool.query(
      'SELECT * FROM get_members($1, $2, $3, $4, $5, $6, $7)',
      [search, category, province, type, sort, limit, offset]
    );
    res.json({ members: result.rows, sort, limit, offset });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
