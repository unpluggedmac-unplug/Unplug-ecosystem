// Site Buttons: a small floating stack of admin-configured CTA buttons
// (icon + label + link) shown on every public page — always visible, not a
// scroll-triggered interruption the way Popups are.
//
// THE PUBLIC HALF IS DELIBERATELY DUMB, same reasoning as Popups: GET
// /site-buttons returns what is switched on, in stack order, and nothing
// else. It does not know who is asking. Cached hard, since it's an endpoint
// every page view calls on a free instance that sleeps.

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
      `SELECT id, label, url, icon
         FROM site_buttons
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
    const r = await pool.query(
      `SELECT * FROM site_buttons ORDER BY display_order, id`
    );
    res.json(r.rows);
  } catch (err) { next(err); }
});

router.post('/', requireRole('admin'), async (req, res, next) => {
  try {
    const label = String(req.body.label || '').trim();
    const url = String(req.body.url || '').trim();
    if (!label || !url) return res.status(400).json({ error: 'A button needs a label and a link.' });

    const r = await pool.query(
      `INSERT INTO site_buttons (label, url, icon, display_order, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [label.slice(0, 60), url.slice(0, 2000), req.body.icon ? String(req.body.icon).slice(0, 20) : null,
        Number.isFinite(Number(req.body.displayOrder)) ? Math.trunc(Number(req.body.displayOrder)) : 0,
        req.user.id]
    );
    await logActivity(req.user.id, 'site_button_created', `Created the site button "${label}"`);
    res.status(201).json(r.rows[0]);
  } catch (err) { next(err); }
});

router.patch('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const fields = [];
    const values = [];
    const set = (column, value) => { values.push(value); fields.push(`${column} = $${values.length}`); };

    if (req.body.label !== undefined) {
      const label = String(req.body.label).trim();
      if (!label) return res.status(400).json({ error: 'Label cannot be blank.' });
      set('label', label.slice(0, 60));
    }
    if (req.body.url !== undefined) {
      const url = String(req.body.url).trim();
      if (!url) return res.status(400).json({ error: 'Link cannot be blank.' });
      set('url', url.slice(0, 2000));
    }
    if (req.body.icon !== undefined) set('icon', req.body.icon ? String(req.body.icon).slice(0, 20) : null);
    if (req.body.displayOrder !== undefined) {
      set('display_order', Number.isFinite(Number(req.body.displayOrder)) ? Math.trunc(Number(req.body.displayOrder)) : 0);
    }
    if (req.body.active !== undefined) set('active', !!req.body.active);
    if (!fields.length) return res.status(400).json({ error: 'Nothing to change.' });
    fields.push('updated_at = now()');

    values.push(req.params.id);
    const r = await pool.query(
      `UPDATE site_buttons SET ${fields.join(', ')} WHERE id = $${values.length} RETURNING *`, values
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'No such button.' });

    // Switching one on is the moment it starts showing to every visitor, so
    // it's recorded as its own event rather than lost inside a generic "updated".
    if (req.body.active !== undefined) {
      await logActivity(req.user.id, req.body.active ? 'site_button_activated' : 'site_button_paused',
        `${req.body.active ? 'Switched on' : 'Paused'} the site button "${r.rows[0].label}"`);
    }
    res.json(r.rows[0]);
  } catch (err) { next(err); }
});

router.delete('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const r = await pool.query('DELETE FROM site_buttons WHERE id = $1 RETURNING label', [req.params.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'No such button.' });
    await logActivity(req.user.id, 'site_button_deleted', `Deleted the site button "${r.rows[0].label}"`);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
