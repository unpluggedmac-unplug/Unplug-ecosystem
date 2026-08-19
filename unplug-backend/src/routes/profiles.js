const express = require('express');
const pool = require('../db');
const { recordConversionAsync } = require('../utils/analyticsRecorder');
const { normaliseTags } = require('../utils/tags');
const { requireAuth, requireRole, requireOwnerOrAdmin } = require('../middleware/auth');
const { getPagination, paginationMeta } = require('../utils/pagination');
const { SA_PROVINCES } = require('../utils/saPlaces');
const { recordParticipationAsync } = require('../utils/participation');

const router = express.Router();

// Public shape of a listing's location. A street address belongs to a business
// premises; an individual's would be their home, so it is stripped before the
// profile ever leaves the API — `SELECT p.*` would otherwise publish it.
// Also builds the display label the frontend shows, so the ordering of the
// parts is decided in one place.
function withPublicLocation(profile) {
  if (!profile) return profile;
  const isBusiness = profile.type === 'business';
  const streetAddress = isBusiness ? profile.street_address : null;
  return {
    ...profile,
    street_address: streetAddress,
    locationLabel: [streetAddress, profile.suburb, profile.city, profile.province, profile.country]
      .filter(Boolean).join(', ') || null,
  };
}

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
      `SELECT p.id, p.slug, p.display_name, p.package_tier, p.bio, p.type, p.deaf_owned_verified, p.feature_image_url, c.name AS category, c2.name AS secondary_category
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
// GET /directory/provinces — the province dropdown options, served from the
// same list the API validates against so the two can't drift apart.
router.get('/directory/provinces', (req, res) => {
  res.json({ provinces: SA_PROVINCES, defaultCountry: 'South Africa' });
});

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

// GET /news/categories — the news-side equivalent, so the admin publish form
// can offer a real category list instead of asking staff to type an id.
router.get('/news/categories', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, name FROM categories WHERE type = 'news' ORDER BY name ASC`
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

    res.json({ profile: withPublicLocation(profile), socials: socials.rows, gallery: gallery.rows });
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
const { type, categoryId, secondaryCategoryId, packageTier, displayName, bio, achievements, career, quote, contactEmail, contactPhone, contactWebsite, demoReelUrl, streetAddress, suburb, city, province, country } = req.body;
    const allowSecondCategory = type === 'business' && packageTier === 'premium';
    const allowDemoReel = type === 'individual' && packageTier === 'premium';
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

    // Location is entirely optional. A street address is only stored for
    // business listings — individuals give area-level location only, so a
    // residential street address is never captured or published.
    const isBusiness = (type || 'individual') === 'business';
    const result = await pool.query(
      `INSERT INTO profiles
        (user_id, type, category_id, secondary_category_id, package_tier, slug, display_name, bio, achievements, career, quote, contact_email, contact_phone, contact_website, demo_reel_url, status,
         street_address, suburb, city, province, country)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'awaiting_payment',
         $16,$17,$18,$19,$20)
       RETURNING *`,
      [req.user.id, type || 'individual', categoryId || null, allowSecondCategory ? (secondaryCategoryId || null) : null, packageTier, slug, displayName.trim(), bio || null, achievements || null, career || null, quote || null, contactEmail || null, contactPhone || null, contactWebsite || null, allowDemoReel ? (demoReelUrl || null) : null,
        isBusiness ? ((streetAddress || '').trim() || null) : null,
        (suburb || '').trim() || null,
        (city || '').trim() || null,
        (province || '').trim() || null,
        (country || '').trim() || null]
    );

    recordConversionAsync({
      userId: req.user.id, eventName: 'listing_submitted',
      entityType: 'profile', entityId: result.rows[0].id,
    });

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
    const bodyKeyMap = {
      bio: 'bio', achievements: 'achievements', career: 'career', quote: 'quote',
      contactEmail: 'contact_email', contactPhone: 'contact_phone', contactWebsite: 'contact_website',
      displayName: 'display_name',
      // The feature/banner image and category. An owner can set these too, but
      // in practice it's editorial (admin) that curates a listing's headline
      // photo and its category placement.
      featureImageUrl: 'feature_image_url',
      categoryId: 'category_id', secondaryCategoryId: 'secondary_category_id',
      // Location powers the directory map and "near me" search, and is entirely
      // OPTIONAL — a listing with no location stays in the directory, it just
      // doesn't get a map marker. Suburb/town alone is enough (the API derives
      // coordinates from them), so latitude/longitude are rarely set by hand.
      //
      // streetAddress is accepted only for business listings; see the guard
      // below. Individuals give area-level location only, so we never publish
      // a residential street address.
      streetAddress: 'street_address', suburb: 'suburb', country: 'country',
      city: 'city', province: 'province', latitude: 'latitude', longitude: 'longitude',
    };

    // Length guards — all optional, but if given they must be sane.
    const LOCATION_LIMITS = {
      streetAddress: 200, suburb: 120, city: 120, province: 80, country: 80,
    };
    for (const [key, max] of Object.entries(LOCATION_LIMITS)) {
      const val = req.body[key];
      if (typeof val === 'string' && val.trim().length > max) {
        return res.status(400).json({ error: `${key} must be ${max} characters or fewer.` });
      }
    }
    if (req.body.province !== undefined && req.body.province) {
      // Only validated when the country is South Africa (or unset) — an
      // international listing may legitimately have a non-SA province/state.
      const country = (req.body.country || '').trim().toLowerCase();
      const isSA = !country || country === 'south africa';
      if (isSA && !SA_PROVINCES.includes(String(req.body.province).trim())) {
        return res.status(400).json({ error: `For South Africa, province must be one of: ${SA_PROVINCES.join(', ')}.` });
      }
    }
    // Never store a street address against an individual, even if one is sent.
    if (req.body.streetAddress) {
      const existing = await pool.query('SELECT type FROM profiles WHERE id = $1', [req.params.id]);
      if (existing.rows.length && existing.rows[0].type !== 'business') {
        return res.status(400).json({ error: 'A street address is only used for business listings. Individual listings use suburb, town, province and country.' });
      }
    }

    // Clearing a location field must store NULL, not '' — "no location" is
    // tested with IS NULL (map eligibility, Near Me), and an empty string
    // would read as a value and keep an unplaceable listing on the map queue.
    const LOCATION_KEYS = new Set(['streetAddress', 'suburb', 'city', 'province', 'country']);
    const setClauses = [];
    const values = [];

    // Tags: words the OWNER chooses to describe what they do, so a reader
    // searching for them finds this listing. Handled outside the allowlist
    // loop because it is the one field that needs cleaning rather than
    // copying — see utils/tags.js for why that lives in one place.
    if (req.body.tags !== undefined) {
      values.push(normaliseTags(req.body.tags));
      setClauses.push(`tags = $${values.length}`);
    }
    for (const [bodyKey, column] of Object.entries(bodyKeyMap)) {
      if (req.body[bodyKey] !== undefined) {
        let value = req.body[bodyKey];
        if (LOCATION_KEYS.has(bodyKey) && typeof value === 'string' && value.trim() === '') value = null;
        values.push(value);
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
    // The OWNER keeping their listing current is the participation; an admin
    // editing someone else's must never earn that member points.
    if (req.user && req.user.id === result.rows[0].user_id) {
      recordParticipationAsync(req.user.id, 'profile_action', {
        contentType: 'profile', contentId: result.rows[0].id,
      });
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
