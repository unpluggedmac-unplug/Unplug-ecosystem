const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const { packagesFor } = require('../utils/servicePackages');

const router = express.Router();

// Placements a member can buy — the human labels for the stable slot_keys that
// exist on the public site (data-ad-slot). Keeping this server-side stops the
// client inventing placements.
const { AD_SLOT_SIZES } = require('../utils/imageSpecs');

const AD_PLACEMENTS = [
  { key: 'home-sponsor-1', label: 'Homepage — Featured Sponsor' },
  { key: 'news-leaderboard', label: 'Latest News — Leaderboard' },
  { key: 'directory-sponsor', label: 'Directory — Sponsor' },
  { key: 'gallery-sponsor', label: 'Gallery — Sponsor' },
  { key: 'top10-sponsor', label: 'Top 10 — Sponsor' },
  { key: 'investors-leaderboard', label: 'Investors — Leaderboard' },
  { key: 'editions-sponsor', label: 'Editions — Sponsor' },
  { key: 'competitions-leaderboard', label: 'Competitions — Leaderboard' },
];
const PLACEMENT_KEYS = AD_PLACEMENTS.map((p) => p.key);

// GET /ad-banners/options — public. Placements + pricing for the buy form.
//
// Durations and prices come from the admin-managed service_packages table (the
// same source resolveAmount() charges from), so an admin price change shows on
// the buy form and on the invoice together. Hardcoding them here once meant the
// form could advertise a price the checkout no longer charged.
router.get('/options', async (req, res, next) => {
  try {
    const list = await packagesFor('ad_banner');
    const prices = {};
    list.forEach((p) => { prices[p.durationDays] = p.price; });
    res.json({
      // Each placement carries the size that slot actually is. The buy form
      // had this dropdown all along and told people "1920 × 600" regardless,
      // which is not the size of any slot on the site.
      placements: AD_PLACEMENTS.map((p) => {
        const s = AD_SLOT_SIZES[p.key];
        return s ? { ...p, size: { w: s.w, h: s.h, label: s.label, text: `${s.w} × ${s.h}px (${s.label})` } } : p;
      }),
      durations: list.map((p) => p.durationDays),
      prices,
      packages: list,
    });
  } catch (err) {
    next(err);
  }
});

// POST /ad-banners — a signed-in member/business submits a banner. It's created
// awaiting payment; after payment it enters the admin approval queue, and only
// goes live once approved (and within its scheduled dates).
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const b = req.body;
    const slotKey = (b.slotKey || '').trim();
    if (!PLACEMENT_KEYS.includes(slotKey)) return res.status(400).json({ error: 'Choose a valid placement.' });
    const durationDays = Number(b.durationDays);
    // Validate against the packages actually on sale right now, so a package an
    // admin has switched off can't be bought by re-posting an old form.
    const onSale = await packagesFor('ad_banner');
    const chosen = onSale.find((p) => p.durationDays === durationDays);
    if (!chosen) {
      return res.status(400).json({
        error: `Choose one of the available durations: ${onSale.map((p) => p.durationDays).join(', ')} days.`,
      });
    }
    const imageUrl = (b.imageUrl || '').trim();
    if (!imageUrl) return res.status(400).json({ error: 'Upload a banner image first.' });
    const linkUrl = (b.linkUrl || '').trim() || null;
    if (linkUrl && !/^https?:\/\//i.test(linkUrl)) return res.status(400).json({ error: 'The link must start with http:// or https://' });

    // Start date: today or a chosen future date; end = start + (duration - 1) days.
    const startDate = (b.startsAt && /^\d{4}-\d{2}-\d{2}$/.test(b.startsAt)) ? new Date(b.startsAt + 'T00:00:00Z') : new Date();
    const startsAt = startDate.toISOString().slice(0, 10);
    const endsAt = new Date(startDate.getTime() + (durationDays - 1) * 86400000).toISOString().slice(0, 10);
    const result = await pool.query(
      `INSERT INTO ad_slots
         (slot_key, image_url, mobile_image_url, link_url, name, cta_text,
          display_order, is_active, starts_at, ends_at,
          owner_user_id, moderation_status, duration_days)
       VALUES ($1, $2, $3, $4, $5, $6, 0, false, $7, $8, $9, 'pending_payment', $10)
       RETURNING id`,
      [
        slotKey, imageUrl, (b.mobileImageUrl || '').trim() || null, linkUrl,
        (b.name || '').trim().slice(0, 160) || null, (b.ctaText || '').trim().slice(0, 40) || null,
        startsAt, endsAt, req.user.id, durationDays,
      ]
    );
    res.status(201).json({
      id: result.rows[0].id,
      linkedType: 'ad_banner',
      linkedId: result.rows[0].id,
      price: chosen.price,
      message: 'Banner created — complete payment, then it goes to admin for approval.',
    });
  } catch (err) { next(err); }
});

// GET /ad-banners/mine — the member's own banners + status.
router.get('/mine', requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, slot_key, image_url, link_url, name, starts_at, ends_at, duration_days,
              is_active, moderation_status, created_at
         FROM ad_slots WHERE owner_user_id = $1 ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json({ banners: result.rows });
  } catch (err) { next(err); }
});

module.exports = router;
