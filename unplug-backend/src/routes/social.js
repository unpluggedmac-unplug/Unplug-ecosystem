// The social feed — posts an admin enters by hand.
//
// NO API CALL HAPPENS ANYWHERE IN THIS FILE, and that is the design rather
// than a shortcut. Instagram's Basic Display API, which every widget of this
// kind was built on, was switched off on 4 December 2024. Its replacement
// needs a Business account, a linked Facebook Page, a Meta app, Meta's app
// review, and a token that expires every sixty days.
//
// The failure mode of that token lapsing is the part that decided it: the feed
// empties itself one morning, nothing errors, nothing is logged, and the
// magazine's homepage quietly looks abandoned until somebody notices. A feed
// that needs typing into cannot fail that way.
//
// The table has a `source` column so an automatic fetcher could be added later
// writing the same rows, with no change to this route or to the frontend.

const express = require('express');
const pool = require('../db');
const { requireRole } = require('../middleware/auth');
const { logActivity } = require('./activityLog');

const router = express.Router();

// Only http(s), and only after parsing. These URLs are written into an anchor
// on a public page, and a stored record edited by a compromised admin session
// is exactly the way a javascript: URL would get there.
function safeUrl(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url.toString();
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

router.get('/feed', async (req, res, next) => {
  try {
    const limit = Math.min(24, Math.max(1, Number(req.query.limit) || 12));
    const r = await pool.query(`
      SELECT id, permalink, image_url, caption, handle, posted_at, source
        FROM social_posts
       WHERE active = true
       -- position first so something can be pinned, then genuinely newest.
       -- Ordering by created_at instead would put last week's post above
       -- yesterday's whenever somebody catches up on data entry on a Friday.
       ORDER BY position DESC, posted_at DESC NULLS LAST, id DESC
       LIMIT $1`, [limit]);

    // Cached for ten minutes. This is on the homepage, it changes when a
    // person types something in, and the instance it comes from sleeps.
    res.set('Cache-Control', 'public, max-age=600');
    res.json(r.rows);
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

router.get('/', requireRole('admin'), async (req, res, next) => {
  try {
    const r = await pool.query(
      'SELECT * FROM social_posts ORDER BY active DESC, position DESC, posted_at DESC NULLS LAST, id DESC LIMIT 200');
    res.json(r.rows);
  } catch (err) { next(err); }
});

router.post('/', requireRole('admin'), async (req, res, next) => {
  try {
    const permalink = safeUrl(req.body.permalink);
    if (!permalink) return res.status(400).json({ error: 'A link to the post is required, and it must be http(s).' });
    const image = req.body.imageUrl ? safeUrl(req.body.imageUrl) : null;
    if (req.body.imageUrl && !image) return res.status(400).json({ error: 'That image address is not a usable URL.' });

    const source = ['manual', 'instagram', 'facebook', 'tiktok'].includes(req.body.source)
      ? req.body.source : 'manual';

    const r = await pool.query(
      `INSERT INTO social_posts (source, permalink, image_url, caption, handle, posted_at, position, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [source, permalink, image, req.body.caption || null,
        (req.body.handle || '').trim().slice(0, 80) || null,
        req.body.postedAt || null, Number(req.body.position) || 0, req.user.id]);

    await logActivity(req.user.id, 'social_post_added', `Added a social post: ${permalink}`);
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That post is already in the feed.' });
    next(err);
  }
});

router.patch('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const fields = [];
    const values = [];
    const set = (col, val) => { values.push(val); fields.push(`${col} = $${values.length}`); };

    if (req.body.permalink !== undefined) {
      const url = safeUrl(req.body.permalink);
      if (!url) return res.status(400).json({ error: 'That link is not a usable URL.' });
      set('permalink', url);
    }
    if (req.body.imageUrl !== undefined) {
      const url = req.body.imageUrl ? safeUrl(req.body.imageUrl) : null;
      if (req.body.imageUrl && !url) return res.status(400).json({ error: 'That image address is not a usable URL.' });
      set('image_url', url);
    }
    if (req.body.caption !== undefined) set('caption', req.body.caption || null);
    if (req.body.handle !== undefined) set('handle', (req.body.handle || '').trim().slice(0, 80) || null);
    if (req.body.postedAt !== undefined) set('posted_at', req.body.postedAt || null);
    if (req.body.position !== undefined) set('position', Number(req.body.position) || 0);
    if (req.body.active !== undefined) set('active', !!req.body.active);
    if (!fields.length) return res.status(400).json({ error: 'Nothing to change.' });

    values.push(req.params.id);
    const r = await pool.query(
      `UPDATE social_posts SET ${fields.join(', ')} WHERE id = $${values.length} RETURNING *`, values);
    if (r.rowCount === 0) return res.status(404).json({ error: 'No such post.' });
    res.json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Another post already has that link.' });
    next(err);
  }
});

router.delete('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const r = await pool.query('DELETE FROM social_posts WHERE id = $1 RETURNING permalink', [req.params.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'No such post.' });
    await logActivity(req.user.id, 'social_post_removed', `Removed a social post: ${r.rows[0].permalink}`);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
