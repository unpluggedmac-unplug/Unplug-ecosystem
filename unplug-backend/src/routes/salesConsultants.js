const express = require('express');
const pool = require('../db');
const { requireRole } = require('../middleware/auth');

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

// GET /sales-consultants/performance — admin. Each consultant's referrals and
// activity in one table.
//
// Only CONFIRMED referrals count toward revenue and commission: an initiated
// payment that was never completed isn't money, and paying commission on it
// would be wrong. Pending ones are reported separately so the pipeline is
// still visible.
router.get('/performance', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT c.id, c.name, c.email, c.commission_pct, c.active, c.user_id,
              COUNT(p.id) FILTER (WHERE p.status = 'confirmed')::int AS confirmed_referrals,
              COUNT(p.id) FILTER (WHERE p.status = 'pending')::int   AS pending_referrals,
              COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'confirmed'), 0)::numeric AS revenue,
              ROUND(COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'confirmed'), 0)
                    * c.commission_pct / 100, 2)                     AS commission_due,
              MAX(p.confirmed_at) FILTER (WHERE p.status = 'confirmed') AS last_sale_at
         FROM sales_consultants c
         LEFT JOIN payments p ON p.sales_consultant_id = c.id
        GROUP BY c.id
        ORDER BY revenue DESC, c.name ASC`
    );
    res.json({ consultants: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /sales-consultants/:id/submissions — admin. What this consultant has
// published themselves, on clients' behalf.
//
// Their attributed SALES already live at /admin/sales-consultants/:id/payments;
// this is the other half — the free publishing their role grants them, so it
// can be seen rather than just trusted.
router.get('/:id/submissions', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'A valid consultant id is required.' });

    const consultant = await pool.query('SELECT id, name, user_id FROM sales_consultants WHERE id = $1', [id]);
    if (consultant.rowCount === 0) return res.status(404).json({ error: 'That consultant no longer exists.' });

    // No linked account means nothing can be attributed — say so rather than
    // returning an empty list that reads as "they've published nothing".
    if (!consultant.rows[0].user_id) {
      return res.json({ consultant: consultant.rows[0], linked: false, submissions: [] });
    }

    const submissions = await pool.query(
      `SELECT 'article' AS kind, id, title AS label, status, created_at
         FROM articles WHERE author_user_id = $1
       UNION ALL
       SELECT 'event' AS kind, id, name AS label, status, created_at
         FROM events WHERE organizer_user_id = $1
       ORDER BY created_at DESC
       LIMIT 100`,
      [consultant.rows[0].user_id]
    );

    res.json({ consultant: consultant.rows[0], linked: true, submissions: submissions.rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
