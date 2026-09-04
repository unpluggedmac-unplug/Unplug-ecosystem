// Testimonials: real quotes from real directory members, advertisers and
// featured people — never fabricated. See migration 173 for why this is a
// mechanism only; the actual quotes are gathered by the publisher.
//
// THE PUBLIC HALF IS DELIBERATELY DUMB, same reasoning as Popups and Site
// Buttons: GET /testimonials returns what is switched on, in display
// order, and nothing else — cached, since it's an endpoint every homepage
// view calls on a free instance that sleeps.

const express = require('express');
const pool = require('../db');
const { requireRole } = require('../middleware/auth');
const { logActivity } = require('./activityLog');

const router = express.Router();

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

router.get('/', async (req, res, next) => {
  try {
    const r = await pool.query(
      `SELECT id, quote, author_name, author_role, author_photo_url
         FROM testimonials
        WHERE active = true
        ORDER BY display_order, id`
    );
    res.set('Cache-Control', 'public, max-age=60');
    res.json(r.rows);
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

router.get('/admin/all', requireRole('admin'), async (req, res, next) => {
  try {
    const r = await pool.query(`SELECT * FROM testimonials ORDER BY display_order, id`);
    res.json(r.rows);
  } catch (err) { next(err); }
});

router.post('/', requireRole('admin'), async (req, res, next) => {
  try {
    const quote = String(req.body.quote || '').trim();
    const authorName = String(req.body.authorName || '').trim();
    if (!quote || !authorName) {
      return res.status(400).json({ error: 'A testimonial needs the quote and who said it.' });
    }
    const r = await pool.query(
      `INSERT INTO testimonials (quote, author_name, author_role, author_photo_url, display_order, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [quote.slice(0, 2000), authorName.slice(0, 160),
        req.body.authorRole ? String(req.body.authorRole).slice(0, 160) : null,
        req.body.authorPhotoUrl ? String(req.body.authorPhotoUrl).slice(0, 2000) : null,
        Number.isFinite(Number(req.body.displayOrder)) ? Math.trunc(Number(req.body.displayOrder)) : 0,
        req.user.id]
    );
    await logActivity(req.user.id, 'testimonial_created', `Added a testimonial from ${authorName}`);
    res.status(201).json(r.rows[0]);
  } catch (err) { next(err); }
});

router.patch('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const fields = [];
    const values = [];
    const set = (column, value) => { values.push(value); fields.push(`${column} = $${values.length}`); };

    if (req.body.quote !== undefined) {
      const quote = String(req.body.quote).trim();
      if (!quote) return res.status(400).json({ error: 'The quote cannot be blank.' });
      set('quote', quote.slice(0, 2000));
    }
    if (req.body.authorName !== undefined) {
      const authorName = String(req.body.authorName).trim();
      if (!authorName) return res.status(400).json({ error: 'The author name cannot be blank.' });
      set('author_name', authorName.slice(0, 160));
    }
    if (req.body.authorRole !== undefined) set('author_role', req.body.authorRole ? String(req.body.authorRole).slice(0, 160) : null);
    if (req.body.authorPhotoUrl !== undefined) set('author_photo_url', req.body.authorPhotoUrl ? String(req.body.authorPhotoUrl).slice(0, 2000) : null);
    if (req.body.displayOrder !== undefined) {
      set('display_order', Number.isFinite(Number(req.body.displayOrder)) ? Math.trunc(Number(req.body.displayOrder)) : 0);
    }
    if (req.body.active !== undefined) set('active', !!req.body.active);
    if (!fields.length) return res.status(400).json({ error: 'Nothing to change.' });
    fields.push('updated_at = now()');

    values.push(req.params.id);
    const r = await pool.query(
      `UPDATE testimonials SET ${fields.join(', ')} WHERE id = $${values.length} RETURNING *`, values
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'No such testimonial.' });

    if (req.body.active !== undefined) {
      await logActivity(req.user.id, req.body.active ? 'testimonial_activated' : 'testimonial_paused',
        `${req.body.active ? 'Switched on' : 'Paused'} the testimonial from ${r.rows[0].author_name}`);
    }
    res.json(r.rows[0]);
  } catch (err) { next(err); }
});

router.delete('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const r = await pool.query('DELETE FROM testimonials WHERE id = $1 RETURNING author_name', [req.params.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'No such testimonial.' });
    await logActivity(req.user.id, 'testimonial_deleted', `Deleted the testimonial from ${r.rows[0].author_name}`);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
