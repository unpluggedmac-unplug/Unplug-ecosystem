const express = require('express');
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { getPagination, paginationMeta } = require('../utils/pagination');
const { logActivity } = require('./activityLog');

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

// ---------------------------------------------------------------------------
// Advertising placements — the "Advertise With Us" rate card on the
// Marketplace page (101_marketplace_placements.sql). These were hardcoded in
// unplug-magazine.html with grey size placeholders; they are now data an
// admin edits, with real images.
// ---------------------------------------------------------------------------

const PLACEMENT_COLUMNS = `id, slug, title, spec_label, description, image_url,
                           button_label, button_target, is_featured, position, is_visible`;

// GET /marketplace/placements — public, visible placements in order.
router.get('/placements', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT ${PLACEMENT_COLUMNS} FROM marketplace_placements
        WHERE is_visible = true ORDER BY position, id`
    );
    res.json({ placements: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /marketplace/admin/placements — admin, including hidden ones.
router.get('/admin/placements', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT ${PLACEMENT_COLUMNS}, updated_at FROM marketplace_placements ORDER BY position, id`
    );
    res.json({ placements: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /marketplace/admin/placements — add a placement to the rate card.
router.post('/admin/placements', requireRole('admin'), async (req, res, next) => {
  try {
    const b = req.body;
    const title = String(b.title || '').trim();
    if (!title) return res.status(400).json({ error: 'Give the placement a title.' });
    // Derived from the title when not supplied, so an admin never has to
    // think about slugs — but still editable, since it is what a future
    // deep link would use.
    const slug = String(b.slug || title).trim().toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
    if (!slug) return res.status(400).json({ error: 'That title has no letters or numbers to build a name from.' });

    const result = await pool.query(
      `INSERT INTO marketplace_placements
         (slug, title, spec_label, description, image_url, button_label, button_target, is_featured, position, is_visible)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING ${PLACEMENT_COLUMNS}`,
      [
        slug, title.slice(0, 160),
        b.specLabel || null, b.description || null, b.imageUrl || null,
        (b.buttonLabel || 'Get In Contact').slice(0, 60),
        (b.buttonTarget || 'contact').slice(0, 255),
        b.isFeatured === true,
        Number.isInteger(Number(b.position)) ? Number(b.position) : 0,
        b.isVisible === false ? false : true,
      ]
    );
    logActivity(req.user.id, 'marketplace_placement_created', `${title} (${slug})`);
    res.status(201).json({ placement: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A placement with that name already exists.' });
    next(err);
  }
});

// PATCH /marketplace/admin/placements/:id — edit one.
router.patch('/admin/placements/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'A valid placement id is required.' });
    const map = {
      title: 'title', specLabel: 'spec_label', description: 'description',
      imageUrl: 'image_url', buttonLabel: 'button_label', buttonTarget: 'button_target',
      isFeatured: 'is_featured', position: 'position', isVisible: 'is_visible',
    };
    const sets = [];
    const values = [];
    for (const [bodyKey, column] of Object.entries(map)) {
      if (req.body[bodyKey] !== undefined) {
        values.push(req.body[bodyKey]);
        sets.push(`${column} = $${values.length}`);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });
    values.push(id);
    const result = await pool.query(
      `UPDATE marketplace_placements SET ${sets.join(', ')}, updated_at = now()
        WHERE id = $${values.length} RETURNING ${PLACEMENT_COLUMNS}`,
      values
    );
    if (!result.rowCount) return res.status(404).json({ error: 'That placement no longer exists.' });
    logActivity(req.user.id, 'marketplace_placement_edited', result.rows[0].title);
    res.json({ placement: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /marketplace/admin/placements/:id — remove one from the rate card.
router.delete('/admin/placements/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'A valid placement id is required.' });
    const result = await pool.query('DELETE FROM marketplace_placements WHERE id = $1 RETURNING title', [id]);
    if (!result.rowCount) return res.status(404).json({ error: 'That placement no longer exists.' });
    logActivity(req.user.id, 'marketplace_placement_deleted', result.rows[0].title);
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
