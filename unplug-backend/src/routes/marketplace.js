const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const { getPagination, paginationMeta } = require('../utils/pagination');

const router = express.Router();

// GET /marketplace/listings — public. Only approved listings currently
// within their active window show up — this is what powers both the
// Marketplace page's "Businesses On The Marketplace" section and the
// homepage's rotating poster slideshow.
router.get('/listings', async (req, res, next) => {
  try {
    const { page, limit, offset } = getPagination(req);
    const activeCondition = `l.status = 'approved'
         AND (l.active_from IS NULL OR l.active_from <= CURRENT_DATE)
         AND (l.active_to IS NULL OR l.active_to >= CURRENT_DATE)`;

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM marketplace_listings l WHERE ${activeCondition}`
    );

    const result = await pool.query(
      `SELECT l.id, l.poster_image_url, l.headline, l.active_from, l.active_to,
              a.business_name, a.contact_email, a.contact_phone, a.contact_website
       FROM marketplace_listings l
       JOIN advertisers a ON a.id = l.advertiser_id
       WHERE ${activeCondition}
       ORDER BY l.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    res.json({
      listings: result.rows,
      pagination: paginationMeta(page, limit, parseInt(countResult.rows[0].count, 10)),
    });
  } catch (err) {
    next(err);
  }
});

// POST /marketplace/listings — advertiser submits a poster: flat R500 for
// a fixed 30-day run. Creates (or reuses) their advertiser record, then
// the listing itself as 'awaiting_payment'. The advertiser can optionally
// choose when the 30-day window should START (e.g. to line up with a
// launch date) — the finish date is computed automatically as
// start + 30 days once payment confirms (see applyPaymentEffect in
// payments.js). If no start date is given, it starts the day payment
// confirms.
router.post('/listings', requireAuth, async (req, res, next) => {
  try {
    const { businessName, contactEmail, contactPhone, contactWebsite, posterImageUrl, headline, requestedStartDate } = req.body;

    if (!posterImageUrl) {
      return res.status(400).json({ error: 'posterImageUrl is required.' });
    }

    let advertiserResult = await pool.query('SELECT id FROM advertisers WHERE user_id = $1', [req.user.id]);
    let advertiserId;
    if (advertiserResult.rows.length === 0) {
      if (!businessName) {
        return res.status(400).json({ error: 'businessName is required for a first-time advertiser.' });
      }
      const created = await pool.query(
        `INSERT INTO advertisers (user_id, business_name, contact_email, contact_phone, contact_website)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [req.user.id, businessName, contactEmail || null, contactPhone || null, contactWebsite || null]
      );
      advertiserId = created.rows[0].id;
    } else {
      advertiserId = advertiserResult.rows[0].id;
    }

    const listing = await pool.query(
      `INSERT INTO marketplace_listings (advertiser_id, poster_image_url, headline, duration_days, requested_start_date)
       VALUES ($1, $2, $3, 30, $4)
       RETURNING *`,
      [advertiserId, posterImageUrl, headline || null, requestedStartDate || null]
    );

    res.status(201).json({
      listing: listing.rows[0],
      message: `Listing created — call POST /payments/initiate with linkedType "marketplace_listing" and this listing's id (R500.00, 30 days) to proceed.`,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
