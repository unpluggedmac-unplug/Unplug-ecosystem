const express = require('express');
const pool = require('../db');

const router = express.Router();

// GET /sales-consultants — public. Any logged-in payer needs this list to
// populate the "How did you hear about us" dropdown when they pick "Sales
// Consultant". Only active consultants, and only id + name — email and
// commission rate stay admin-only (see /admin/sales-consultants).
router.get('/', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, name FROM sales_consultants WHERE active = true ORDER BY name ASC`
    );
    res.json({ consultants: result.rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
