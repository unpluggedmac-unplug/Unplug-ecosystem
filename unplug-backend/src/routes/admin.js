const express = require('express');
const pool = require('../db');
const { requireRole } = require('../middleware/auth');
const { logActivity } = require('./activityLog');

const router = express.Router();

// Tier + type → free credits granted on approval, per the locked Master Plan.
function creditsForTier(type, tier) {
  if (type === 'individual') {
    if (tier === 'pro') return { article: 1, event: 0, arena: 0, gallery: 1 };
    if (tier === 'premium') return { article: 1, event: 1, arena: 1, gallery: 2 };
  } else if (type === 'business') {
    if (tier === 'pro') return { article: 1, event: 0, arena: 0, gallery: 0 };
    if (tier === 'premium') return { article: 1, event: 1, arena: 0, gallery: 0 };
  }
  return { article: 0, event: 0, arena: 0, gallery: 0 };
}

// GET /admin/users
// Admin-only — lists every user account. This is a working example of how
// every other /admin/* route from the Backend Spec (Section 3) should be
// wired: requireRole('admin') first, then the actual query.
router.get('/users', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT id, email, phone, role, created_at FROM users ORDER BY created_at DESC'
    );
    res.json({ users: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /admin/vouchers — admin-only. Lists every voucher ever created.
router.get('/vouchers', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT v.*, u.email AS created_by_email,
              (SELECT COUNT(*) FROM voucher_redemptions r WHERE r.voucher_id = v.id) AS times_redeemed
       FROM vouchers v
       LEFT JOIN users u ON u.id = v.created_by
       ORDER BY v.created_at DESC`
    );
    res.json({ vouchers: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /admin/vouchers — admin-only. Creates a new voucher code.
// discount_type: 'percent' or 'fixed'. expires_at is mandatory.
// service_restriction is optional — omit or leave blank for "any service".
router.post('/vouchers', requireRole('admin'), async (req, res, next) => {
  try {
    const { code, discountType, discountValue, serviceRestriction, expiresAt } = req.body;
    if (!code || !discountType || !discountValue || !expiresAt) {
      return res.status(400).json({ error: 'code, discountType, discountValue, and expiresAt are all required.' });
    }
    if (!['percent', 'fixed'].includes(discountType)) {
      return res.status(400).json({ error: 'discountType must be "percent" or "fixed".' });
    }
    const result = await pool.query(
      `INSERT INTO vouchers (code, discount_type, discount_value, service_restriction, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [code.toUpperCase().trim(), discountType, discountValue, serviceRestriction || null, expiresAt, req.user.id]
    );
    await logActivity(req.user.id, 'voucher_created', `Voucher ${result.rows[0].code} — ${discountType} ${discountValue}`);
    res.status(201).json({ voucher: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'That voucher code already exists.' });
    }
    next(err);
  }
});

// PATCH /admin/vouchers/:id/deactivate — admin-only. Turns a voucher off
// without deleting its redemption history.
router.patch('/vouchers/:id/deactivate', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE vouchers SET active = false WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Voucher not found.' });
    }
    await logActivity(req.user.id, 'voucher_deactivated', `Voucher ${result.rows[0].code}`);
    res.json({ voucher: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /admin/profiles/pending
// Admin-only — the Directory tab of the Approval Queue.
router.get('/profiles/pending', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT p.id, p.display_name, p.package_tier, p.status, p.created_at, c.name AS category, u.email AS submitted_by
       FROM profiles p
       LEFT JOIN categories c ON c.id = p.category_id
       JOIN users u ON u.id = p.user_id
       WHERE p.status = 'pending'
       ORDER BY p.created_at ASC`
    );
    res.json({ profiles: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /admin/profiles/renewals-due — admin-only. Lists approved profiles
// whose renews_at falls within the next 30 days, or has already passed.
router.get('/profiles/renewals-due', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT p.id, p.display_name, p.type, p.package_tier, p.renews_at, u.email AS contact_email
       FROM profiles p
       JOIN users u ON u.id = p.user_id
       WHERE p.status = 'approved' AND p.renews_at IS NOT NULL AND p.renews_at <= now() + interval '30 days'
       ORDER BY p.renews_at ASC`
    );
    res.json({ profiles: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /admin/profiles/approved
// Admin-only — lists all approved Directory profiles, with verification
// and credit-renewal status, so there's somewhere to use the Verify and
// Renew actions after a profile has already been approved.
router.get('/profiles/approved', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT p.id, p.display_name, p.type, p.package_tier, p.verified, p.deaf_owned_verified, p.renews_at, c.name AS category, u.email AS submitted_by
       FROM profiles p
       LEFT JOIN categories c ON c.id = p.category_id
       JOIN users u ON u.id = p.user_id
       WHERE p.status = 'approved'
       ORDER BY p.display_name ASC`
    );
    res.json({ profiles: result.rows });
  } catch (err) {
    next(err);
  }
});

// PATCH /admin/profiles/:id/approve
router.patch('/profiles/:id/approve', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE profiles SET status = 'approved', updated_at = now() WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Profile not found.' });
    }
    const profile = result.rows[0];
    const credits = creditsForTier(profile.type, profile.package_tier);
    const credited = await pool.query(
      `UPDATE profiles SET free_article_credits = $1, free_event_credits = $2, free_arena_credits = $3,
              free_gallery_credits = $4, credits_renewed_at = now(), renews_at = now() + interval '1 year'
       WHERE id = $5 RETURNING *`,
      [credits.article, credits.event, credits.arena, credits.gallery, profile.id]
    );
    await logActivity(req.user.id, 'profile_approved', `Profile #${req.params.id} — ${profile.display_name}`);
    res.json({ profile: credited.rows[0] });
  } catch (err) {
    next(err);
  }
});

// PATCH /admin/profiles/:id/verify — admin confirms the ID document or
// business registration number checked outside this system, then flips
// the Verified badge on. `note` is a free-text reference (e.g. document
// type or registration number), not the document itself.
router.patch('/profiles/:id/verify', requireRole('admin'), async (req, res, next) => {
  try {
    const { note } = req.body;
    const result = await pool.query(
      `UPDATE profiles SET verified = true, verification_note = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [note || null, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Profile not found.' });
    }
    await logActivity(req.user.id, 'profile_verified', `Profile #${req.params.id} — ${result.rows[0].display_name}`);
    res.json({ profile: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// PATCH /admin/profiles/:id/deaf-owned — toggles the Deaf-Owned Verified
// badge on a profile. Flipping (not just setting true) lets one button in
// the admin queue both grant and remove the badge.
router.patch('/profiles/:id/deaf-owned', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE profiles SET deaf_owned_verified = NOT deaf_owned_verified, updated_at = now()
       WHERE id = $1 RETURNING id, display_name, deaf_owned_verified`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Profile not found.' });
    }
    await logActivity(req.user.id, 'profile_deaf_owned_toggled',
      `Profile #${req.params.id} — ${result.rows[0].display_name} → deaf-owned ${result.rows[0].deaf_owned_verified}`);
    res.json({ profile: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// PATCH /admin/profiles/:id/renew — call this once a year (manually, for
// now) to refresh a profile's included credits and push its renewal date
// out another year. No downgrade path exists, so this always re-grants
// whatever the profile's CURRENT tier includes.
router.patch('/profiles/:id/renew', requireRole('admin'), async (req, res, next) => {
  try {
    const profileResult = await pool.query('SELECT * FROM profiles WHERE id = $1', [req.params.id]);
    if (profileResult.rows.length === 0) {
      return res.status(404).json({ error: 'Profile not found.' });
    }
    const profile = profileResult.rows[0];
    const credits = creditsForTier(profile.type, profile.package_tier);
    const result = await pool.query(
      `UPDATE profiles SET free_article_credits = $1, free_event_credits = $2, free_arena_credits = $3,
              free_gallery_credits = $4, renews_at = now() + interval '1 year', updated_at = now()
       WHERE id = $5 RETURNING *`,
      [credits.article, credits.event, credits.arena, credits.gallery, req.params.id]
    );
    await logActivity(req.user.id, 'profile_renewed', `Profile #${req.params.id} — ${profile.display_name} — credits refreshed for another year`);
    res.json({ profile: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// PATCH /admin/profiles/:id/reject
router.patch('/profiles/:id/reject', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE profiles SET status = 'rejected', updated_at = now() WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Profile not found.' });
    }
    await logActivity(req.user.id, 'profile_rejected', `Profile #${req.params.id} — ${result.rows[0].display_name}`);
    res.json({ profile: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /admin/gallery/pending
// Admin-only — the Gallery tab of the Approval Queue (covers profile,
// investor, and general gallery submissions in one list).
router.get('/gallery/pending', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, owner_type, owner_id, image_url, caption, supplied_by, created_at
       FROM gallery_images
       WHERE status = 'pending'
       ORDER BY created_at ASC`
    );
    res.json({ images: result.rows });
  } catch (err) {
    next(err);
  }
});

// PATCH /admin/gallery/:id/approve
router.patch('/gallery/:id/approve', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE gallery_images SET status = 'approved' WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Image not found.' });
    }
    res.json({ image: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// PATCH /admin/gallery/:id/reject
router.patch('/gallery/:id/reject', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE gallery_images SET status = 'rejected' WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Image not found.' });
    }
    res.json({ image: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /admin/articles/pending — the Latest News tab of the Approval Queue.
router.get('/articles/pending', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT a.id, a.title, a.kicker_supplied_by, a.created_at, c.name AS category, u.email AS submitted_by
       FROM articles a
       LEFT JOIN categories c ON c.id = a.category_id
       JOIN users u ON u.id = a.author_user_id
       WHERE a.status = 'pending'
       ORDER BY a.created_at ASC`
    );
    res.json({ articles: result.rows });
  } catch (err) {
    next(err);
  }
});

// PATCH /admin/articles/:id/approve — sets published_at so it appears
// immediately in the public /articles feed.
router.patch('/articles/:id/approve', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE articles SET status = 'approved', published_at = now() WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Article not found.' });
    }
    await logActivity(req.user.id, 'article_approved', `Article #${req.params.id} — ${result.rows[0].title}`);
    res.json({ article: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// PATCH /admin/articles/:id/reject
router.patch('/articles/:id/reject', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE articles SET status = 'rejected' WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Article not found.' });
    }
    await logActivity(req.user.id, 'article_rejected', `Article #${req.params.id} — ${result.rows[0].title}`);
    res.json({ article: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /admin/events/pending — the Events tab of the Approval Queue.
router.get('/events/pending', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT e.id, e.name, e.event_date, e.venue, e.created_at, u.email AS organizer
       FROM events e
       JOIN users u ON u.id = e.organizer_user_id
       WHERE e.status = 'pending'
       ORDER BY e.event_date ASC`
    );
    res.json({ events: result.rows });
  } catch (err) {
    next(err);
  }
});

// PATCH /admin/events/:id/approve
router.patch('/events/:id/approve', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE events SET status = 'approved' WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found.' });
    }
    res.json({ event: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// PATCH /admin/events/:id/reject
router.patch('/events/:id/reject', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE events SET status = 'rejected' WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found.' });
    }
    res.json({ event: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /admin/entries/pending — the Competitions tab of the Approval Queue.
// Only shows entries that have already been paid for (status 'pending') —
// entries still 'awaiting_payment' aren't an admin's problem yet.
router.get('/entries/pending', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT ce.id, ce.competition_id, ce.entry_fee, ce.created_at, p.display_name, c.name AS competition_name
       FROM competition_entries ce
       JOIN profiles p ON p.id = ce.profile_id
       JOIN competitions c ON c.id = ce.competition_id
       WHERE ce.status = 'pending'
       ORDER BY ce.created_at ASC`
    );
    res.json({ entries: result.rows });
  } catch (err) {
    next(err);
  }
});

// PATCH /admin/entries/:id/approve
router.patch('/entries/:id/approve', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE competition_entries SET status = 'approved' WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Entry not found.' });
    }
    res.json({ entry: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// PATCH /admin/entries/:id/reject
router.patch('/entries/:id/reject', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE competition_entries SET status = 'rejected' WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Entry not found.' });
    }
    res.json({ entry: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /admin/investors/pending — the Investors tab of the Approval Queue.
router.get('/investors/pending', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT i.id, i.name, i.contact_email, i.created_at, u.email AS submitted_by
       FROM investors i
       JOIN users u ON u.id = i.user_id
       WHERE i.status = 'pending'
       ORDER BY i.created_at ASC`
    );
    res.json({ investors: result.rows });
  } catch (err) {
    next(err);
  }
});

// PATCH /admin/investors/:id/approve
router.patch('/investors/:id/approve', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE investors SET status = 'approved' WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Investor not found.' });
    }
    res.json({ investor: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// PATCH /admin/investors/:id/reject
router.patch('/investors/:id/reject', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE investors SET status = 'rejected' WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Investor not found.' });
    }
    res.json({ investor: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /admin/marketplace/pending — the Marketplace tab of the Approval
// Queue (banners and ads submitted by advertisers).
router.get('/marketplace/pending', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT l.id, l.headline, l.duration_days, l.created_at, a.business_name
       FROM marketplace_listings l
       JOIN advertisers a ON a.id = l.advertiser_id
       WHERE l.status = 'pending'
       ORDER BY l.created_at ASC`
    );
    res.json({ listings: result.rows });
  } catch (err) {
    next(err);
  }
});

// PATCH /admin/marketplace/:id/approve
router.patch('/marketplace/:id/approve', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE marketplace_listings SET status = 'approved' WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Listing not found.' });
    }
    res.json({ listing: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// PATCH /admin/marketplace/:id/reject
router.patch('/marketplace/:id/reject', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE marketplace_listings SET status = 'rejected' WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Listing not found.' });
    }
    res.json({ listing: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /admin/highlights/pending — the Highlights & Promotions tab.
router.get('/highlights/pending', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, target_type, target_id, duration_days, created_at
       FROM highlights
       WHERE status = 'pending'
       ORDER BY created_at ASC`
    );
    res.json({ highlights: result.rows });
  } catch (err) {
    next(err);
  }
});

// PATCH /admin/highlights/:id/approve
router.patch('/highlights/:id/approve', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE highlights SET status = 'approved' WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Highlight not found.' });
    }
    res.json({ highlight: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// PATCH /admin/highlights/:id/reject
router.patch('/highlights/:id/reject', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE highlights SET status = 'rejected' WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Highlight not found.' });
    }
    res.json({ highlight: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /admin/sales-consultants — full list (active + inactive).
router.get('/sales-consultants', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(`SELECT * FROM sales_consultants ORDER BY name ASC`);
    res.json({ consultants: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /admin/sales-consultants — add a new consultant.
router.post('/sales-consultants', requireRole('admin'), async (req, res, next) => {
  try {
    const { name, email, commissionPct } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'name is required.' });
    }
    const result = await pool.query(
      `INSERT INTO sales_consultants (name, email, commission_pct)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [name.trim(), email || null, commissionPct != null ? commissionPct : 10.00]
    );
    res.status(201).json({ consultant: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// PATCH /admin/sales-consultants/:id — edit name/email/commission/active.
router.patch('/sales-consultants/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const bodyKeyMap = { name: 'name', email: 'email', commissionPct: 'commission_pct', active: 'active' };
    const setClauses = [];
    const values = [];
    for (const [bodyKey, column] of Object.entries(bodyKeyMap)) {
      if (req.body[bodyKey] !== undefined) {
        values.push(req.body[bodyKey]);
        setClauses.push(`${column} = $${values.length}`);
      }
    }
    if (setClauses.length === 0) {
      return res.status(400).json({ error: 'No editable fields provided.' });
    }
    values.push(req.params.id);

    const result = await pool.query(
      `UPDATE sales_consultants SET ${setClauses.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Consultant not found.' });
    }
    res.json({ consultant: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /admin/sales-consultants/:id/payments — every confirmed payment
// attributed to this consultant, for commission calculation. The
// commission amount is computed here (amount × commission_pct) rather
// than stored on each payment, so changing a consultant's rate later
// doesn't require rewriting historical records.
router.get('/sales-consultants/:id/payments', requireRole('admin'), async (req, res, next) => {
  try {
    const consultantResult = await pool.query('SELECT * FROM sales_consultants WHERE id = $1', [req.params.id]);
    if (consultantResult.rows.length === 0) {
      return res.status(404).json({ error: 'Consultant not found.' });
    }
    const consultant = consultantResult.rows[0];

    const payments = await pool.query(
      `SELECT id, amount, method, linked_type, linked_id, status, confirmed_at, created_at
       FROM payments
       WHERE sales_consultant_id = $1 AND status = 'confirmed'
       ORDER BY confirmed_at DESC`,
      [req.params.id]
    );

    const totalSales = payments.rows.reduce((sum, p) => sum + Number(p.amount), 0);
    const totalCommission = totalSales * (Number(consultant.commission_pct) / 100);

    res.json({
      consultant,
      payments: payments.rows,
      totalSales,
      totalCommission: Math.round(totalCommission * 100) / 100,
    });
  } catch (err) {
    next(err);
  }
});

// GET /admin/notifications — unread-first feed. A sales-consultant-linked
// payment automatically creates one of these (see payments.js) so the
// admin doesn't have to go hunting through the full payments table.
router.get('/notifications', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT * FROM admin_notifications ORDER BY read ASC, created_at DESC LIMIT 50`
    );
    res.json({ notifications: result.rows });
  } catch (err) {
    next(err);
  }
});

// PATCH /admin/notifications/:id/read
router.patch('/notifications/:id/read', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE admin_notifications SET read = true WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Notification not found.' });
    }
    res.json({ notification: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /admin/settings — every platform setting (currently just the Bundle
// Vote price, but this grows into a general config screen over time).
router.get('/settings', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(`SELECT key, value, updated_at FROM settings ORDER BY key ASC`);
    res.json({ settings: result.rows });
  } catch (err) {
    next(err);
  }
});

// PATCH /admin/settings/:key — update a single setting. Kept generic
// (rather than a dedicated bundle-vote-price endpoint) so future settings
// don't each need their own route.
router.patch('/settings/:key', requireRole('admin'), async (req, res, next) => {
  try {
    const { value } = req.body;
    if (value === undefined || value === null || value === '') {
      return res.status(400).json({ error: 'value is required.' });
    }
    if (req.params.key === 'bundle_vote_price' && isNaN(parseFloat(value))) {
      return res.status(400).json({ error: 'bundle_vote_price must be a number.' });
    }

    const result = await pool.query(
      `UPDATE settings SET value = $1, updated_at = now() WHERE key = $2 RETURNING *`,
      [String(value), req.params.key]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: `Setting "${req.params.key}" does not exist.` });
    }
    res.json({ setting: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /admin/top10-entries/pending — paid Top 10 consideration requests
// waiting on admin review (separate from publishing the actual rankings).
router.get('/top10-entries/pending', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT te.id, te.entry_fee, te.created_at, p.display_name
       FROM top10_entries te
       JOIN profiles p ON p.id = te.profile_id
       WHERE te.status = 'pending'
       ORDER BY te.created_at ASC`
    );
    res.json({ entries: result.rows });
  } catch (err) {
    next(err);
  }
});

// PATCH /admin/top10-entries/:id/approve
router.patch('/top10-entries/:id/approve', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE top10_entries SET status = 'approved' WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Entry not found.' });
    }
    res.json({ entry: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// PATCH /admin/top10-entries/:id/reject
router.patch('/top10-entries/:id/reject', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE top10_entries SET status = 'rejected' WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Entry not found.' });
    }
    res.json({ entry: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /admin/shoutouts/pending — public shoutout nominations awaiting review.
// Approving one adds it to the daily rotation on the homepage.
router.get('/shoutouts/pending', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, nominee_name, message, submitted_by_email, created_at
       FROM shoutout_nominations
       WHERE status = 'pending'
       ORDER BY created_at ASC`
    );
    res.json({ nominations: result.rows });
  } catch (err) {
    next(err);
  }
});

// PATCH /admin/shoutouts/:id/approve — enters the nomination into rotation.
router.patch('/shoutouts/:id/approve', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE shoutout_nominations SET status = 'approved' WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Nomination not found.' });
    }
    res.json({ nomination: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// PATCH /admin/shoutouts/:id/reject
router.patch('/shoutouts/:id/reject', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE shoutout_nominations SET status = 'rejected' WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Nomination not found.' });
    }
    res.json({ nomination: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
