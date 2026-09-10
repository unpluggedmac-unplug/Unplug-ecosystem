const express = require('express');
const pool = require('../db');
const { requireRole } = require('../middleware/auth');
const { logActivity } = require('./activityLog');

const router = express.Router();

// Known image-bearing columns. We check information_schema before querying so
// older/staging databases that have not reached every migration still work.
const SOURCES = [
  ['articles', 'banner_image_url', 'Article', 'title'],
  ['articles', 'gallery_images', 'Article gallery', 'title', 'array'],
  ['events', 'poster_image_url', 'Event', 'name'],
  ['profiles', 'feature_image_url', 'Directory profile', 'display_name'],
  ['gallery_images', 'image_url', 'Gallery', 'title'],
  ['impact_makers', 'photo_url', 'Impact Maker', 'display_name'],
  ['page_blocks', 'image_url', 'Page block', 'title'],
  ['ad_slots', 'image_url', 'Banner', 'name'],
  ['ad_slots', 'mobile_image_url', 'Banner mobile', 'name'],
  ['marketplace_listings', 'poster_image_url', 'Marketplace', 'headline'],
  ['editions', 'cover_image_url', 'Edition', 'title'],
  ['birthdays', 'photo_url', 'Birthday', 'name'],
  ['hall_of_fame', 'photo_url', 'Hall of Fame', 'name'],
  ['testimonials', 'author_photo_url', 'Testimonial', 'author_name'],
  ['article_authors', 'photo_url', 'Contributor', 'display_name'],
  ['share_cards', 'photo_url', 'Share card', 'title'],
  ['top10_rankings', 'cover_image_url', 'Top 10', 'id'],
];

async function availableColumns() {
  const r = await pool.query(`SELECT table_name, column_name, data_type
    FROM information_schema.columns WHERE table_schema='public'`);
  const set = new Map();
  for (const row of r.rows) set.set(`${row.table_name}.${row.column_name}`, row.data_type);
  return set;
}

async function discoverReferences() {
  const cols = await availableColumns();
  const refs = new Map();
  for (const [table, column, kind, labelColumn, mode] of SOURCES) {
    if (!cols.has(`${table}.${column}`) || !cols.has(`${table}.id`)) continue;
    const labelExists = cols.has(`${table}.${labelColumn}`);
    try {
      let sql;
      if (mode === 'array') {
        sql = `SELECT id, ${labelExists ? `COALESCE(${labelColumn}::text,'')` : `''`} AS label,
          unnest(${column})::text AS url FROM ${table}
          WHERE ${column} IS NOT NULL AND cardinality(${column}) > 0`;
      } else {
        sql = `SELECT id, ${labelExists ? `COALESCE(${labelColumn}::text,'')` : `''`} AS label,
          ${column}::text AS url FROM ${table}
          WHERE ${column} IS NOT NULL AND btrim(${column}::text) <> ''`;
      }
      const rows = (await pool.query(sql)).rows;
      for (const row of rows) {
        const url = String(row.url || '').trim();
        if (!/^https?:\/\//i.test(url) && !url.startsWith('/')) continue;
        if (!refs.has(url)) refs.set(url, []);
        refs.get(url).push({ type: kind, id: row.id, label: row.label || `#${row.id}` });
      }
    } catch (e) {
      // A legacy column with an unexpected type must not take the whole media
      // library down. Skip it and leave the rest visible.
      console.warn('[admin media] source skipped', `${table}.${column}`, e.message);
    }
  }

  // Page-content image settings are stored as generic values rather than a
  // dedicated image column. Limit this to keys that are actually image-ish.
  if (cols.has('page_content.value') && cols.has('page_content.content_key')) {
    const rows = (await pool.query(`SELECT page_key, content_key, value FROM page_content
      WHERE value IS NOT NULL AND btrim(value) <> ''
        AND (content_key ILIKE '%image%' OR content_key ILIKE '%photo%' OR content_key ILIKE '%cover%')`)).rows;
    for (const row of rows) {
      const url = String(row.value || '').trim();
      if (!/^https?:\/\//i.test(url) && !url.startsWith('/')) continue;
      if (!refs.has(url)) refs.set(url, []);
      refs.get(url).push({ type: 'Site image', id: `${row.page_key}.${row.content_key}`, label: row.page_key });
    }
  }
  return refs;
}

// GET /admin/media — indexed uploads + images already referenced by content.
router.get('/', requireRole('admin'), async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase();
    const trash = req.query.trash === '1' || req.query.trash === 'true';
    const references = await discoverReferences();
    // First visit to the library adopts already-referenced images into the
    // catalogue. This is intentionally metadata-only: no bytes are copied and
    // no content URL changes. It simply makes older uploads editable/searchable
    // alongside new ones.
    const existingUrls = [...references.keys()];
    if (existingUrls.length) {
      await pool.query(`INSERT INTO media_assets (url, filename, storage)
        SELECT u, regexp_replace(split_part(u, '?', 1), '^.*/', ''), 'existing'
        FROM unnest($1::text[]) AS u
        ON CONFLICT (url) DO NOTHING`, [existingUrls]);
    }
    const assets = await pool.query(`SELECT m.*, u.email AS uploader_email
      FROM media_assets m LEFT JOIN users u ON u.id=m.uploaded_by
      WHERE ${trash ? 'm.trashed_at IS NOT NULL' : 'm.trashed_at IS NULL'}
      ORDER BY m.created_at DESC LIMIT 1000`);

    const byUrl = new Map();
    for (const a of assets.rows) {
      byUrl.set(a.url, { ...a, indexed: true, references: references.get(a.url) || [] });
    }
    if (!trash) {
      for (const [url, refs] of references) {
        if (!byUrl.has(url)) byUrl.set(url, {
          id: null, url, filename: url.split('/').pop() || 'image', storage: 'existing',
          size_bytes: null, alt_text: null, caption: null, uploaded_by: null,
          uploader_email: null, created_at: null, trashed_at: null, indexed: false,
          references: refs,
        });
      }
    }

    let items = [...byUrl.values()].map((a) => ({ ...a, usage_count: a.references.length }));
    if (q) items = items.filter((a) => [a.filename, a.alt_text, a.caption, a.url,
      ...(a.references || []).flatMap((r) => [r.type, r.label])]
      .some((v) => String(v || '').toLowerCase().includes(q)));

    items.sort((a, b) => (b.usage_count - a.usage_count)
      || (new Date(b.created_at || 0) - new Date(a.created_at || 0)));
    res.json({ items, total: items.length, trash });
  } catch (err) { next(err); }
});

router.patch('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Valid media id required.' });
    const alt = req.body.altText == null ? null : String(req.body.altText).trim().slice(0, 1000);
    const caption = req.body.caption == null ? null : String(req.body.caption).trim().slice(0, 2000);
    const r = await pool.query(`UPDATE media_assets SET alt_text=$1, caption=$2, updated_at=now()
      WHERE id=$3 RETURNING *`, [alt || null, caption || null, id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Media item not found.' });
    await logActivity(req.user.id, 'media_metadata_updated', `Media #${id}`);
    res.json({ item: r.rows[0] });
  } catch (err) { next(err); }
});

// Trash is catalogue-only and deliberately does NOT delete the object from R2
// or Supabase. If an image is still used somewhere, destroying the bytes would
// break the public page instantly.
router.post('/:id/trash', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const found = await pool.query('SELECT * FROM media_assets WHERE id=$1 AND trashed_at IS NULL', [id]);
    if (!found.rowCount) return res.status(404).json({ error: 'Media item not found or already trashed.' });
    const refs = await discoverReferences();
    const usedBy = refs.get(found.rows[0].url) || [];
    if (usedBy.length) {
      return res.status(409).json({
        error: `This image is still used in ${usedBy.length} place${usedBy.length === 1 ? '' : 's'}. Remove or replace it there before moving it to Trash.`,
        references: usedBy,
      });
    }
    const r = await pool.query(`UPDATE media_assets SET trashed_at=now(), trashed_by=$1, updated_at=now()
      WHERE id=$2 AND trashed_at IS NULL RETURNING *`, [req.user.id, id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Media item not found or already trashed.' });
    await logActivity(req.user.id, 'media_trashed', `Media #${id}: ${r.rows[0].filename || r.rows[0].url}`);
    res.json({ item: r.rows[0] });
  } catch (err) { next(err); }
});

router.post('/:id/restore', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const r = await pool.query(`UPDATE media_assets SET trashed_at=NULL, trashed_by=NULL, updated_at=now()
      WHERE id=$1 AND trashed_at IS NOT NULL RETURNING *`, [id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Media item not found in Trash.' });
    await logActivity(req.user.id, 'media_restored', `Media #${id}`);
    res.json({ item: r.rows[0] });
  } catch (err) { next(err); }
});

module.exports = router;
