// CONTRIBUTORS — the people who write for Unplug.
//
// A byline that is only text tells a reader a name. A byline that links to a
// page — photo, short bio, everything they have written — is what separates a
// publication from a website that publishes articles.
//
// Kept separate from `profiles` (the Directory) and from `users` (accounts) on
// purpose: a contributor is not necessarily a member, a member is not
// necessarily a contributor, and a Directory listing is a business, not a
// writer. Linking them would mean one of those three meanings quietly
// changing the other two.

const express = require('express');
const pool = require('../db');
const { requireRole } = require('../middleware/auth');
const { slugify } = require('../utils/articleMeta');
const { logActivity } = require('./activityLog');

const router = express.Router();

// Public-facing columns only. email and user_id are internal — a contributor
// page is a public page, and an email address on it is an invitation to spam.
const PUBLIC_COLUMNS = 'id, name, slug, role_title, bio, photo_url';

async function uniqueSlug(base, ignoreId = null) {
  const root = slugify(base) || 'contributor';
  for (let n = 0; n < 50; n++) {
    const candidate = n === 0 ? root : `${root}-${n + 1}`;
    const clash = await pool.query(
      'SELECT 1 FROM contributors WHERE slug = $1 AND ($2::int IS NULL OR id <> $2)',
      [candidate, ignoreId]
    );
    if (clash.rowCount === 0) return candidate;
  }
  return `${root}-${Date.now()}`;
}

// GET /contributors — the public masthead. Active contributors only, with a
// count of what each has published, so the page leads with the people who
// actually write rather than whoever was added first.
router.get('/', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT ${PUBLIC_COLUMNS},
              (SELECT COUNT(*)::int FROM articles a
                WHERE a.contributor_id = c.id
                  AND a.status = 'approved'
                  AND (a.scheduled_for IS NULL OR a.scheduled_for <= CURRENT_DATE)) AS article_count
         FROM contributors c
        WHERE c.is_active = TRUE
        ORDER BY article_count DESC, c.name ASC`
    );
    res.json({ contributors: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /contributors/admin/all — declared BEFORE /:slug, otherwise "admin" is
// read as a contributor slug and this never runs.
router.get('/admin/all', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT c.*,
              (SELECT COUNT(*)::int FROM articles a WHERE a.contributor_id = c.id) AS article_count
         FROM contributors c
        ORDER BY c.is_active DESC, c.name ASC`
    );
    res.json({ contributors: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /contributors/:slug — one contributor and everything they have written.
// Only published, already-scheduled articles: this is a public page, so a
// draft or a future-dated piece must not be reachable through it.
router.get('/:slug', async (req, res, next) => {
  try {
    const found = await pool.query(
      `SELECT ${PUBLIC_COLUMNS} FROM contributors WHERE slug = $1 AND is_active = TRUE`,
      [String(req.params.slug)]
    );
    if (found.rows.length === 0) {
      return res.status(404).json({ error: 'Contributor not found.' });
    }
    const contributor = found.rows[0];

    const articles = await pool.query(
      `SELECT a.id, a.title, a.subtitle, a.slug, a.banner_image_url, a.published_at,
              c.name AS category
         FROM articles a
         LEFT JOIN categories c ON c.id = a.category_id
        WHERE a.contributor_id = $1
          AND a.status = 'approved'
          AND (a.scheduled_for IS NULL OR a.scheduled_for <= CURRENT_DATE)
        ORDER BY a.published_at DESC NULLS LAST, a.id DESC`,
      [contributor.id]
    );

    res.json({ contributor, articles: articles.rows });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

router.post('/admin', requireRole('admin'), async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'A name is required.' });

    const result = await pool.query(
      `INSERT INTO contributors (name, slug, role_title, bio, photo_url, email, user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [name, await uniqueSlug(name),
        req.body.roleTitle || null, req.body.bio || null, req.body.photoUrl || null,
        req.body.email || null, req.body.userId || null]
    );
    await logActivity(req.user.id, 'contributor_created', `Added contributor ${name}`).catch(() => {});
    res.status(201).json({ contributor: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

router.patch('/admin/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'A valid id is required.' });

    const sets = [];
    const values = [];
    const put = (column, value) => { values.push(value); sets.push(`${column} = $${values.length}`); };

    if (req.body.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name) return res.status(400).json({ error: 'A name cannot be blank.' });
      put('name', name);
    }
    if (req.body.roleTitle !== undefined) put('role_title', req.body.roleTitle || null);
    if (req.body.bio !== undefined) put('bio', req.body.bio || null);
    if (req.body.photoUrl !== undefined) put('photo_url', req.body.photoUrl || null);
    if (req.body.email !== undefined) put('email', req.body.email || null);
    if (req.body.isActive !== undefined) put('is_active', !!req.body.isActive);
    // The slug is where their published page lives, so it changes only when
    // asked for explicitly — never as a side effect of correcting a name.
    if (req.body.slug !== undefined && String(req.body.slug).trim()) {
      put('slug', await uniqueSlug(req.body.slug, id));
    }

    if (sets.length === 0) return res.status(400).json({ error: 'No changes provided.' });

    values.push(id);
    const result = await pool.query(
      `UPDATE contributors SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Contributor not found.' });

    await logActivity(req.user.id, 'contributor_updated',
      `Updated contributor ${result.rows[0].name}`).catch(() => {});
    res.json({ contributor: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /contributors/admin/:id — refused while articles still credit them.
// Deactivating removes someone from the contributors page and keeps their
// byline on their work; deleting would strip the link from every article they
// ever wrote, which is not what "remove this person from the list" means to
// whoever clicked it.
router.delete('/admin/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'A valid id is required.' });

    const used = await pool.query(
      'SELECT COUNT(*)::int AS n FROM articles WHERE contributor_id = $1', [id]
    );
    if (used.rows[0].n > 0) {
      return res.status(409).json({
        error: `This contributor is credited on ${used.rows[0].n} article${used.rows[0].n === 1 ? '' : 's'}. `
          + 'Deactivate them instead — that removes them from the contributors page and keeps their byline on their work.',
        articleCount: used.rows[0].n,
      });
    }

    const result = await pool.query('DELETE FROM contributors WHERE id = $1 RETURNING name', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Contributor not found.' });

    await logActivity(req.user.id, 'contributor_deleted',
      `Deleted contributor ${result.rows[0].name}`).catch(() => {});
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
