const express = require('express');
const pool = require('../db');
const { requireAuth, requireRole, requireOwnerOrAdmin } = require('../middleware/auth');
const { getPagination, paginationMeta } = require('../utils/pagination');

const router = express.Router();

const TIERS = ['basic', 'pro', 'premium']; // order matters — index = rank
const PROFILE_TYPES = ['individual', 'business'];
const UPGRADE_FEE = 250.00;

function slugify(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

async function getProfileOwnerId(req) {
  const result = await pool.query('SELECT user_id FROM profiles WHERE id = $1', [req.params.id]);
  if (result.rows.length === 0) return null;
  return result.rows[0].user_id;
}

// ---------------------------------------------------------------------------
// GET /directory — public. Filter by category and/or package tier.
// Only approved profiles are visible to guests; admins can pass
// ?status=pending to review the queue via the same endpoint if useful,
// but the dedicated /admin/profiles/pending route (in admin.js) is the
// primary way the Admin Dashboard will do that.
// ---------------------------------------------------------------------------
router.get('/directory', async (req, res, next) => {
  try {
   const { category, package: packageTier, type, ids } = req.query;
    const conditions = [`p.status = 'approved'`];
    const values = [];

    if (category) {
      values.push(category);
      conditions.push(`(c.name = $${values.length} OR c2.name = $${values.length})`);
    }
    if (packageTier) {
      values.push(packageTier);
      conditions.push(`p.package_tier = $${values.length}`);
    }
    if (type) {
      values.push(type);
      conditions.push(`p.type = $${values.length}`);
    }
    if (ids) {
      const idList = ids.split(',').map((id) => parseInt(id, 10)).filter(Number.isInteger);
      if (idList.length === 0) {
        return res.json({ profiles: [], pagination: paginationMeta(1, 20, 0) });
      }
      values.push(idList);
      conditions.push(`p.id = ANY($${values.length})`);
    }

    const { page, limit, offset } = getPagination(req);

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM profiles p
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN categories c2 ON c2.id = p.secondary_category_id
       WHERE ${conditions.join(' AND ')}`,
      values
    );

    const result = await pool.query(
      `SELECT p.id, p.slug, p.display_name, p.package_tier, p.bio, c.name AS category, c2.name AS secondary_category
       FROM profiles p
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN categories c2 ON c2.id = p.secondary_category_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY CASE p.package_tier WHEN 'premium' THEN 0 WHEN 'pro' THEN 1 ELSE 2 END, p.display_name ASC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      values.concat([limit, offset])
    );
    res.json({
      profiles: result.rows,
      pagination: paginationMeta(page, limit, parseInt(countResult.rows[0].count, 10)),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /directory/categories — public. Powers the category dropdown on
// signup and the category filter buttons on the Directory page.
// ---------------------------------------------------------------------------
router.get('/directory/categories', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, name FROM categories WHERE type = 'directory' ORDER BY name ASC`
    );
    res.json({ categories: result.rows });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /profiles/me — the authenticated member's own profile, regardless
// of status (awaiting_payment/pending/approved/rejected), plus their own
// socials and gallery images at ANY status — not just approved, since
// this is their own content and they should see what's still pending.
router.get('/profiles/me', requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT p.*, c.name AS category, c2.name AS secondary_category
       FROM profiles p
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN categories c2 ON c2.id = p.secondary_category_id
       WHERE p.user_id = $1`,
      [req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No profile found for this account yet.' });
    }
    const profile = result.rows[0];

    const [socials, gallery, upgrades] = await Promise.all([
      pool.query(`SELECT platform, url FROM social_links WHERE owner_type = 'profile' AND owner_id = $1`, [profile.id]),
      pool.query(`SELECT id, image_url, caption, status FROM gallery_images WHERE owner_type = 'profile' AND owner_id = $1 ORDER BY created_at DESC`, [profile.id]),
      pool.query(`SELECT id, from_tier, to_tier, fee_paid, paid_at, created_at FROM profile_upgrades WHERE profile_id = $1 ORDER BY created_at DESC`, [profile.id]),
    ]);

    res.json({ profile, socials: socials.rows, gallery: gallery.rows, upgrades: upgrades.rows });
  } catch (err) {
    next(err);
  }
});

// GET /profiles/:slug — public. Full detail depends on package tier:
// Basic gets bio only; Pro adds achievements/career/quote/socials;
// Premium adds gallery + linked videos. The frontend decides what to render,
// but we include everything here and let the tier gate what's shown, since
// hiding data server-side would make future tier changes harder to manage.
// ---------------------------------------------------------------------------
router.get('/profiles/:slug', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT p.*, c.name AS category, c2.name AS secondary_category
       FROM profiles p
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN categories c2 ON c2.id = p.secondary_category_id
       WHERE p.slug = $1 AND p.status = 'approved'`,
      [req.params.slug]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Profile not found.' });
    }
    const profile = result.rows[0];

    const [socials, gallery] = await Promise.all([
      pool.query(`SELECT platform, url FROM social_links WHERE owner_type = 'profile' AND owner_id = $1`, [profile.id]),
      pool.query(`SELECT id, image_url, caption FROM gallery_images WHERE owner_type = 'profile' AND owner_id = $1 AND status = 'approved'`, [profile.id]),
    ]);

    res.json({ profile, socials: socials.rows, gallery: gallery.rows });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /profiles — member creates their own profile (enters as 'pending').
// One profile per user account, per the schema's unique index.
// ---------------------------------------------------------------------------
router.post('/profiles', requireAuth, async (req, res, next) => {
  try {
    const { type, categoryId, secondaryCategoryId, packageTier, displayName, bio, achievements, career, quote, contactEmail, contactPhone, contactWebsite } = req.body;
    const allowSecondCategory = type === 'business' && packageTier === 'premium';
    if (!TIERS.includes(packageTier)) {
      return res.status(400).json({ error: `packageTier must be one of: ${TIERS.join(', ')}` });
    }
    
    if (!displayName || !displayName.trim()) {
      return res.status(400).json({ error: 'displayName is required.' });
    }

    const existing = await pool.query('SELECT id FROM profiles WHERE user_id = $1', [req.user.id]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'This account already has a profile.' });
    }

    let slug = slugify(displayName);
    const slugTaken = await pool.query('SELECT id FROM profiles WHERE slug = $1', [slug]);
    if (slugTaken.rows.length > 0) {
      slug = `${slug}-${req.user.id}`;
    }

    const result = await pool.query(
      `INSERT INTO profiles
        (user_id, type, category_id, package_tier, slug, display_name, bio, achievements, career, quote, contact_email, contact_phone, contact_website, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'awaiting_payment')
       RETURNING *`,
      [req.user.id, type || 'individual', categoryId || null, packageTier, slug, displayName.trim(), bio || null, achievements || null, career || null, quote || null, contactEmail || null, contactPhone || null, contactWebsite || null]
    );

    res.status(201).json({
      profile: result.rows[0],
      message: 'Profile created — awaiting payment. Call POST /payments/initiate with linkedType "profile_package" and this profile\'s id to proceed.',
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PATCH /profiles/:id — owner or admin can edit. Editing does not reset
// approval status back to pending in this simple version; add that later
// if re-review on every edit becomes a requirement.
// ---------------------------------------------------------------------------
router.patch('/profiles/:id', requireOwnerOrAdmin(getProfileOwnerId), async (req, res, next) => {
  try {
    const fields = ['bio', 'achievements', 'career', 'quote', 'contact_email', 'contact_phone', 'contact_website', 'display_name'];
    const bodyKeyMap = {
      bio: 'bio', achievements: 'achievements', career: 'career', quote: 'quote',
      contactEmail: 'contact_email', contactPhone: 'contact_phone', contactWebsite: 'contact_website',
      displayName: 'display_name',
    };

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
    setClauses.push(`updated_at = now()`);

    const result = await pool.query(
      `UPDATE profiles SET ${setClauses.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Profile not found.' });
    }
    res.json({ profile: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /profiles/:id/upgrade — owner requests a move to a higher tier.
// Flat R250 fee regardless of tier gap, per the locked Master Blueprint.
// Downgrades are rejected outright. This creates the upgrade record and
// expects payment to be completed separately (Step 3) before the tier
// actually changes — see the note in the response.
// ---------------------------------------------------------------------------
router.post('/profiles/:id/upgrade', requireOwnerOrAdmin(getProfileOwnerId), async (req, res, next) => {
  try {
    const { toTier } = req.body;
    if (!TIERS.includes(toTier)) {
      return res.status(400).json({ error: `toTier must be one of: ${TIERS.join(', ')}` });
    }

    const profileResult = await pool.query('SELECT package_tier FROM profiles WHERE id = $1', [req.params.id]);
    if (profileResult.rows.length === 0) {
      return res.status(404).json({ error: 'Profile not found.' });
    }
    const currentTier = profileResult.rows[0].package_tier;
    const currentRank = TIERS.indexOf(currentTier);
    const targetRank = TIERS.indexOf(toTier);

    if (targetRank <= currentRank) {
      return res.status(400).json({ error: 'Downgrades are not available — you can only move to a higher package.' });
    }

    const upgrade = await pool.query(
      `INSERT INTO profile_upgrades (profile_id, from_tier, to_tier, fee_paid)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [req.params.id, currentTier, toTier, UPGRADE_FEE]
    );

    res.status(201).json({
      upgrade: upgrade.rows[0],
      message: `Upgrade to ${toTier} created. Call POST /payments/initiate with linkedType "profile_upgrade" and this upgrade's id (R${UPGRADE_FEE.toFixed(2)}) — the tier changes once payment is confirmed.`,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
