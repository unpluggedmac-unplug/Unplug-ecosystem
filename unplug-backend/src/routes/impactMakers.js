// Impact Makers — a digital recognition gallery of people, brands, sponsors,
// partners and organisations contributing to the Unplug ecosystem. See
// migration 175 for why this has its own category table rather than
// reusing Directory's shared one.
//
// THE PUBLIC HALF IS DELIBERATELY DUMB, same reasoning as Testimonials/
// Popups/Site Buttons: GET /impact-makers returns what is published, in
// display order, and nothing else — cached, since it's an endpoint the
// gallery page and the homepage teaser both call.

const express = require('express');
const pool = require('../db');
const { requireRole } = require('../middleware/auth');
const { logActivity } = require('./activityLog');

const router = express.Router();

const SOCIAL_COLUMNS = [
  ['instagramUrl', 'instagram_url'],
  ['facebookUrl', 'facebook_url'],
  ['linkedinUrl', 'linkedin_url'],
  ['tiktokUrl', 'tiktok_url'],
  ['youtubeUrl', 'youtube_url'],
  ['xUrl', 'x_url'],
  ['websiteUrl', 'website_url'],
];

// A shape check, not a reachability check — this only refuses obvious
// nonsense (a value that isn't even http(s)), the same bar every other
// admin-entered URL on this site is held to.
function isValidUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

// The fields spec §17 requires before a profile can go live. Takes the
// MERGED row (existing DB values overlaid with whatever this request is
// changing) so a PATCH that sends only `{ status: 'published' }` is judged
// on what the row will actually contain, not just what this one request sent.
function missingForPublish(row) {
  const missing = [];
  if (!row.display_name || !String(row.display_name).trim()) missing.push('name');
  if (!row.photo_url) missing.push('a profile/brand image');
  if (!row.bio || !String(row.bio).trim()) missing.push('the 5-sentence bio');
  if (!row.category_id) missing.push('a category');
  if (!row.impact_maker_type) missing.push('an Impact Maker type');
  return missing;
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

router.get('/', async (req, res, next) => {
  try {
    const r = await pool.query(
      `SELECT m.id, m.first_name, m.surname, m.display_name, m.photo_url,
              m.impact_maker_type, m.bio, m.featured, m.slug,
              m.instagram_url, m.facebook_url, m.linkedin_url, m.tiktok_url,
              m.youtube_url, m.x_url, m.website_url,
              c.id AS category_id, c.name AS category_name
         FROM impact_makers m
         LEFT JOIN impact_maker_categories c ON c.id = m.category_id
        WHERE m.status = 'published'
        ORDER BY m.featured DESC, m.display_order, m.id`
    );
    res.set('Cache-Control', 'public, max-age=60');
    res.json(r.rows);
  } catch (err) { next(err); }
});

router.get('/categories', async (req, res, next) => {
  try {
    const r = await pool.query(
      `SELECT id, name FROM impact_maker_categories ORDER BY display_order, name`
    );
    res.set('Cache-Control', 'public, max-age=300');
    res.json(r.rows);
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

router.get('/admin/all', requireRole('admin'), async (req, res, next) => {
  try {
    const r = await pool.query(
      `SELECT m.*, c.name AS category_name
         FROM impact_makers m
         LEFT JOIN impact_maker_categories c ON c.id = m.category_id
        ORDER BY m.display_order, m.id`
    );
    res.json(r.rows);
  } catch (err) { next(err); }
});

router.post('/', requireRole('admin'), async (req, res, next) => {
  try {
    const displayName = String(req.body.displayName || '').trim();
    if (!displayName) {
      return res.status(400).json({ error: 'An Impact Maker needs a name.' });
    }
    for (const [bodyKey] of SOCIAL_COLUMNS) {
      const value = req.body[bodyKey];
      if (value && !isValidUrl(String(value).trim())) {
        return res.status(400).json({ error: `${bodyKey} does not look like a real web address.` });
      }
    }
    const r = await pool.query(
      `INSERT INTO impact_makers (
         first_name, surname, display_name, photo_url, category_id, impact_maker_type, bio,
         instagram_url, facebook_url, linkedin_url, tiktok_url, youtube_url, x_url, website_url,
         display_order, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING *`,
      [
        req.body.firstName ? String(req.body.firstName).slice(0, 80) : null,
        req.body.surname ? String(req.body.surname).slice(0, 80) : null,
        displayName.slice(0, 160),
        req.body.photoUrl ? String(req.body.photoUrl).slice(0, 2000) : null,
        req.body.categoryId ? Number(req.body.categoryId) : null,
        req.body.impactMakerType ? String(req.body.impactMakerType) : 'individual',
        req.body.bio ? String(req.body.bio).slice(0, 4000) : null,
        ...SOCIAL_COLUMNS.map(([bodyKey]) => (req.body[bodyKey] ? String(req.body[bodyKey]).trim().slice(0, 500) : null)),
        Number.isFinite(Number(req.body.displayOrder)) ? Math.trunc(Number(req.body.displayOrder)) : 0,
        req.user.id,
      ]
    );
    await logActivity(req.user.id, 'impact_maker_created', `Added Impact Maker "${displayName}"`);
    res.status(201).json(r.rows[0]);
  } catch (err) { next(err); }
});

router.patch('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const existing = await pool.query('SELECT * FROM impact_makers WHERE id = $1', [req.params.id]);
    if (existing.rowCount === 0) return res.status(404).json({ error: 'No such Impact Maker.' });
    const current = existing.rows[0];

    const fields = [];
    const values = [];
    const set = (column, value) => { values.push(value); fields.push(`${column} = $${values.length}`); };
    const merged = { ...current };

    if (req.body.firstName !== undefined) { const v = req.body.firstName ? String(req.body.firstName).slice(0, 80) : null; set('first_name', v); merged.first_name = v; }
    if (req.body.surname !== undefined) { const v = req.body.surname ? String(req.body.surname).slice(0, 80) : null; set('surname', v); merged.surname = v; }
    if (req.body.displayName !== undefined) {
      const displayName = String(req.body.displayName).trim();
      if (!displayName) return res.status(400).json({ error: 'The name cannot be blank.' });
      set('display_name', displayName.slice(0, 160));
      merged.display_name = displayName;
    }
    if (req.body.photoUrl !== undefined) { const v = req.body.photoUrl ? String(req.body.photoUrl).slice(0, 2000) : null; set('photo_url', v); merged.photo_url = v; }
    if (req.body.categoryId !== undefined) { const v = req.body.categoryId ? Number(req.body.categoryId) : null; set('category_id', v); merged.category_id = v; }
    if (req.body.impactMakerType !== undefined) { const v = String(req.body.impactMakerType); set('impact_maker_type', v); merged.impact_maker_type = v; }
    if (req.body.bio !== undefined) { const v = req.body.bio ? String(req.body.bio).slice(0, 4000) : null; set('bio', v); merged.bio = v; }
    if (req.body.featured !== undefined) set('featured', !!req.body.featured);
    if (req.body.displayOrder !== undefined) {
      set('display_order', Number.isFinite(Number(req.body.displayOrder)) ? Math.trunc(Number(req.body.displayOrder)) : 0);
    }

    for (const [bodyKey, column] of SOCIAL_COLUMNS) {
      if (req.body[bodyKey] === undefined) continue;
      const raw = req.body[bodyKey] ? String(req.body[bodyKey]).trim() : '';
      if (raw && !isValidUrl(raw)) {
        return res.status(400).json({ error: `${bodyKey} does not look like a real web address.` });
      }
      const v = raw ? raw.slice(0, 500) : null;
      set(column, v);
      merged[column] = v;
    }

    if (req.body.status !== undefined) {
      const status = String(req.body.status);
      if (!['draft', 'published', 'archived'].includes(status)) {
        return res.status(400).json({ error: 'Status must be draft, published or archived.' });
      }
      if (status === 'published') {
        const missing = missingForPublish(merged);
        if (missing.length) {
          return res.status(400).json({ error: `This Impact Maker cannot be published yet — still needs: ${missing.join(', ')}.` });
        }
      }
      set('status', status);
    }

    if (!fields.length) return res.status(400).json({ error: 'Nothing to change.' });
    fields.push('updated_at = now()');

    values.push(req.params.id);
    const r = await pool.query(
      `UPDATE impact_makers SET ${fields.join(', ')} WHERE id = $${values.length} RETURNING *`, values
    );

    if (req.body.status !== undefined) {
      await logActivity(req.user.id, 'impact_maker_status_changed',
        `Set "${r.rows[0].display_name}" to ${r.rows[0].status}`);
    }
    res.json(r.rows[0]);
  } catch (err) { next(err); }
});

router.delete('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const r = await pool.query('DELETE FROM impact_makers WHERE id = $1 RETURNING display_name', [req.params.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'No such Impact Maker.' });
    await logActivity(req.user.id, 'impact_maker_deleted', `Deleted Impact Maker "${r.rows[0].display_name}"`);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// --- category admin CRUD ---------------------------------------------------

router.post('/categories', requireRole('admin'), async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'A category needs a name.' });
    const r = await pool.query(
      `INSERT INTO impact_maker_categories (name, display_order) VALUES ($1, $2)
       ON CONFLICT (name) DO NOTHING RETURNING *`,
      [name.slice(0, 80), Number.isFinite(Number(req.body.displayOrder)) ? Math.trunc(Number(req.body.displayOrder)) : 0]
    );
    if (r.rowCount === 0) return res.status(409).json({ error: 'That category already exists.' });
    res.status(201).json(r.rows[0]);
  } catch (err) { next(err); }
});

router.patch('/categories/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const fields = [];
    const values = [];
    const set = (column, value) => { values.push(value); fields.push(`${column} = $${values.length}`); };
    if (req.body.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name) return res.status(400).json({ error: 'The category name cannot be blank.' });
      set('name', name.slice(0, 80));
    }
    if (req.body.displayOrder !== undefined) {
      set('display_order', Number.isFinite(Number(req.body.displayOrder)) ? Math.trunc(Number(req.body.displayOrder)) : 0);
    }
    if (!fields.length) return res.status(400).json({ error: 'Nothing to change.' });
    values.push(req.params.id);
    const r = await pool.query(
      `UPDATE impact_maker_categories SET ${fields.join(', ')} WHERE id = $${values.length} RETURNING *`, values
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'No such category.' });
    res.json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That category name is already in use.' });
    next(err);
  }
});

router.delete('/categories/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const r = await pool.query('DELETE FROM impact_maker_categories WHERE id = $1 RETURNING name', [req.params.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'No such category.' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
