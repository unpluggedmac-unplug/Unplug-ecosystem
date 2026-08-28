const express = require('express');
const pool = require('../db');
const { requireRole } = require('../middleware/auth');
const { logActivity } = require('./activityLog');

const router = express.Router();

// ---------------------------------------------------------------------------
// EVERY IMAGE ON THE SITE, IN ONE PLACE.
//
// The Cover Images screen used to know about exactly two things: articles and
// directory listings. Every other image on the site — an event's picture, a
// magazine cover, a marketplace poster, a contributor's portrait — could only
// be changed by finding the item in whichever admin screen happened to own it,
// if that screen offered the field at all. Several did not.
//
// The list below is the whole of it. The table and column names are CONSTANTS
// in this file: nothing in a request ever names a table or a column, so the
// worst a malformed request can do is be rejected.
//
// `titleSql` exists because not every table has a plain title column — a
// competition entry linked to a profile has no manual_name of its own — and a
// raw expression here is safe for the same reason the table names are.
// ---------------------------------------------------------------------------
const COVERS = {
  // --- things that appear in a public listing --------------------------
  article: {
    label: 'Articles', group: 'Content',
    table: 'articles', image: 'banner_image_url',
    titleSql: 'title', metaSql: "status", order: 'created_at DESC',
  },
  directory: {
    label: 'Directory Listings', group: 'Content',
    table: 'profiles', image: 'feature_image_url',
    titleSql: 'display_name', metaSql: "status", order: 'display_name ASC',
    // SQUARE. Taken from what the site actually renders, not from the spec
    // document, which says 1200x1200 on one page and 1920x1080 on another for
    // this same field: .dir-photo is aspect-ratio 1/1 on the Directory card
    // and in the members grid, and .profile-photo-lg is a 110x110 circle on
    // the listing page. A 16:9 upload is centre-cropped everywhere.
    hint: '1200 × 1200px (square) — shown as a square in the Directory and as a circle on the listing, so keep the subject centred.',
  },
  event: {
    label: 'Events', group: 'Content',
    table: 'events', image: 'image_url',
    titleSql: 'name', metaSql: "status", order: 'event_date DESC NULLS LAST',
  },
  edition: {
    label: 'Editions', group: 'Content',
    table: 'editions', image: 'cover_image_url',
    titleSql: "COALESCE(NULLIF(TRIM(title), ''), 'Issue ' || issue_number)",
    metaSql: "'Issue ' || issue_number", order: 'issue_number DESC',
  },
  marketplace: {
    label: 'Marketplace Posters', group: 'Content',
    table: 'marketplace_listings', image: 'poster_image_url',
    titleSql: "COALESCE(NULLIF(TRIM(headline), ''), 'Listing #' || id)",
    metaSql: 'status', order: 'created_at DESC',
  },
  competition: {
    label: 'Competition Entries', group: 'Content',
    table: 'competition_entries', image: 'manual_image_url',
    // An entry linked to a Directory profile carries no name of its own; the
    // public page shows the profile's. Saying so beats printing "Entry #12".
    titleSql: "COALESCE(NULLIF(TRIM(manual_name), ''), 'Entry #' || id)",
    metaSql: "CASE WHEN profile_id IS NOT NULL THEN 'uses the listing''s image' ELSE status END",
    order: 'created_at DESC',
  },

  // --- portraits of people ---------------------------------------------
  //
  // Grouped separately because they are not covers in the same sense: a
  // contributor's photograph is of a person, and swapping it is a different
  // kind of act from changing the picture on a story.
  contributor: {
    label: 'Contributors', group: 'People',
    table: 'contributors', image: 'photo_url',
    titleSql: 'name', metaSql: "COALESCE(role_title, '')", order: 'name ASC',
  },
  halloffame: {
    label: 'Hall of Fame', group: 'People',
    table: 'hall_of_fame', image: 'photo_url',
    titleSql: 'name', metaSql: "COALESCE(title, '') || ' ' || COALESCE(year::text, '')",
    order: 'year DESC NULLS LAST, name ASC',
  },
  birthday: {
    label: 'Birthdays', group: 'People',
    table: 'birthdays', image: 'photo_url',
    titleSql: 'name', metaSql: 'status', order: 'name ASC',
  },
  passport: {
    label: 'Deaf Passports', group: 'People',
    table: 'deaf_passports', image: 'profile_image_url',
    titleSql: 'name', metaSql: 'status', order: 'name ASC',
  },
};

// Projects are the odd one out and are handled on their own path below: their
// images live in project_images with an is_cover flag, so a project's cover is
// CHOSEN from pictures it already has rather than uploaded separately. An
// uploaded-elsewhere cover could show a picture that appears nowhere in the
// project's own gallery.
const PROJECT_TYPE = 'project';

// An admin is not a hostile user, but a stored `javascript:` in an image field
// is still a thing that should never be possible. Empty means "clear it".
// https is required rather than our own storage specifically, because covers
// imported from the old WordPress site are external and must stay editable.
function cleanImageUrl(raw) {
  const v = String(raw === null || raw === undefined ? '' : raw).trim();
  if (!v) return { ok: true, value: null };
  if (!/^https:\/\//i.test(v)) {
    return { ok: false, error: 'An image address must start with https://' };
  }
  if (v.length > 2000) return { ok: false, error: 'That image address is too long.' };
  return { ok: true, value: v };
}

// GET /admin/covers/types — what can be managed, for building the filter.
router.get('/types', requireRole('admin'), (req, res) => {
  const types = Object.entries(COVERS).map(([key, c]) => ({ key, label: c.label, group: c.group, mode: 'upload' }));
  types.push({ key: PROJECT_TYPE, label: 'Investor Projects', group: 'Content', mode: 'pick' });
  res.json({ types });
});

// GET /admin/covers/:type — every item of that kind with its current image.
router.get('/:type', requireRole('admin'), async (req, res, next) => {
  try {
    const type = String(req.params.type);

    if (type === PROJECT_TYPE) {
      const r = await pool.query(
        `SELECT p.id, p.title AS title, p.status AS meta,
                (SELECT pi.image_url FROM project_images pi
                  WHERE pi.project_id = p.id AND pi.is_cover = true LIMIT 1) AS cover,
                (SELECT COUNT(*) FROM project_images pi WHERE pi.project_id = p.id)::int AS image_count
           FROM projects p ORDER BY p.created_at DESC`);
      return res.json({
        type, label: 'Investor Projects', mode: 'pick',
        items: r.rows.map((x) => ({
          id: x.id, title: x.title, cover: x.cover,
          meta: `${x.meta} · ${x.image_count} image${x.image_count === 1 ? '' : 's'}`,
          pickable: x.image_count > 0,
        })),
      });
    }

    const c = COVERS[type];
    if (!c) return res.status(404).json({ error: 'Unknown kind of image.' });

    const r = await pool.query(
      `SELECT id, ${c.titleSql} AS title, ${c.image} AS cover, ${c.metaSql} AS meta
         FROM ${c.table} ORDER BY ${c.order}`);
    res.json({ type, label: c.label, mode: 'upload', hint: c.hint || null, items: r.rows });
  } catch (err) {
    next(err);
  }
});

// GET /admin/covers/project/:id/images — the pictures a project already has,
// so one of them can be made the cover.
router.get('/project/:id/images', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'A valid id is required.' });
    const r = await pool.query(
      `SELECT id, image_url, alt_text, caption, is_cover
         FROM project_images WHERE project_id = $1 ORDER BY display_order ASC, id ASC`, [id]);
    res.json({ images: r.rows });
  } catch (err) {
    next(err);
  }
});

// PATCH /admin/covers/project/:id — make one of a project's images the cover.
//
// In ONE transaction, because a project with two covers renders whichever the
// database happens to return first, and a project with none loses its picture
// from the listing entirely. Both are states somebody would have to notice on
// the public site to discover.
router.patch('/project/:id', requireRole('admin'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    const imageId = req.body && req.body.imageId === null ? null : Number(req.body && req.body.imageId);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'A valid project id is required.' });

    await client.query('BEGIN');
    if (imageId !== null && !Number.isInteger(imageId)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'A valid image id is required.' });
    }
    if (imageId !== null) {
      const owns = await client.query(
        'SELECT 1 FROM project_images WHERE id = $1 AND project_id = $2', [imageId, id]);
      if (!owns.rows.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'That image does not belong to this project.' });
      }
    }
    await client.query('UPDATE project_images SET is_cover = false WHERE project_id = $1', [id]);
    if (imageId !== null) {
      await client.query('UPDATE project_images SET is_cover = true WHERE id = $1', [imageId]);
    }
    await client.query('COMMIT');

    await logActivity(req.user.id, 'cover_changed',
      imageId === null ? `Cleared the cover on project #${id}` : `Set image #${imageId} as the cover of project #${id}`);
    res.json({ ok: true, projectId: id, imageId });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// PATCH /admin/covers/:type/:id — set or clear one item's image.
router.patch('/:type/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const type = String(req.params.type);
    const c = COVERS[type];
    if (!c) return res.status(404).json({ error: 'Unknown kind of image.' });
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'A valid id is required.' });

    const cleaned = cleanImageUrl(req.body && req.body.imageUrl);
    if (!cleaned.ok) return res.status(400).json({ error: cleaned.error });

    const r = await pool.query(
      `UPDATE ${c.table} SET ${c.image} = $1 WHERE id = $2 RETURNING id, ${c.image} AS cover`,
      [cleaned.value, id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found.' });

    await logActivity(req.user.id, 'cover_changed',
      `${cleaned.value ? 'Changed' : 'Removed'} the image on ${c.label} #${id}`);
    res.json({ item: r.rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.COVERS = COVERS;
