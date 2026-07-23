const express = require('express');
const pool = require('../db');
const { requireRole } = require('../middleware/auth');
const { logActivity } = require('./activityLog');

const router = express.Router();

// GET /page-cms — public. One call returns every override and every visible
// block for the whole site, because the magazine is a single-page app that
// switches pages client-side: fetching per page would mean a round trip on
// every navigation.
router.get('/', async (req, res, next) => {
  try {
    const content = await pool.query('SELECT page_key, content_key, value FROM page_content');
    const blocks = await pool.query(
      `SELECT id, page_key, title, subheading, description, image_url,
              button_label, button_url, position
         FROM page_blocks
        WHERE is_visible = true
        ORDER BY page_key, position, id`
    );
    const ads = await pool.query('SELECT slot_key, image_url, link_url FROM ad_slots');
    // Shape content as { "home.hero.title": "…" } so the frontend can look up
    // a data-cms attribute directly without walking nested objects.
    const contentMap = {};
    content.rows.forEach((r) => { contentMap[`${r.page_key}.${r.content_key}`] = r.value; });
    const blocksByPage = {};
    blocks.rows.forEach((b) => {
      if (!blocksByPage[b.page_key]) blocksByPage[b.page_key] = [];
      blocksByPage[b.page_key].push(b);
    });
    // Keyed by slot so the page can look up a data-ad-slot directly.
    const adSlots = {};
    ads.rows.forEach((a) => { adSlots[a.slot_key] = { image_url: a.image_url, link_url: a.link_url }; });
    res.json({ content: contentMap, blocks: blocksByPage, adSlots });
  } catch (err) {
    next(err);
  }
});

// GET /page-cms/admin/content — admin, the raw rows for the editor.
router.get('/admin/content', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT page_key, content_key, value, updated_at FROM page_content ORDER BY page_key, content_key'
    );
    res.json({ content: result.rows });
  } catch (err) {
    next(err);
  }
});

// PUT /page-cms/admin/content — admin upserts a piece of copy. Sending an
// empty value deletes the override, which is how you revert a page to its
// built-in wording rather than being stuck with your own edit forever.
router.put('/admin/content', requireRole('admin'), async (req, res, next) => {
  try {
    const pageKey = (req.body.pageKey || '').trim();
    const contentKey = (req.body.contentKey || '').trim();
    const value = req.body.value === undefined || req.body.value === null ? '' : String(req.body.value);
    if (!pageKey || !contentKey) {
      return res.status(400).json({ error: 'A page and a content key are required.' });
    }
    if (!value.trim()) {
      await pool.query(
        'DELETE FROM page_content WHERE page_key = $1 AND content_key = $2',
        [pageKey, contentKey]
      );
      logActivity(req.user.id, 'cms_content_reverted', `${pageKey}.${contentKey}`);
      return res.json({ reverted: true, message: 'Cleared — the page is back to its built-in wording.' });
    }
    await pool.query(
      `INSERT INTO page_content (page_key, content_key, value)
       VALUES ($1, $2, $3)
       ON CONFLICT (page_key, content_key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [pageKey, contentKey, value]
    );
    logActivity(req.user.id, 'cms_content_changed', `${pageKey}.${contentKey}`);
    res.json({ saved: true, message: 'Saved — the change is live on the site.' });
  } catch (err) {
    next(err);
  }
});

// GET /page-cms/admin/blocks — admin, including hidden ones.
router.get('/admin/blocks', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, page_key, title, subheading, description, image_url,
              button_label, button_url, position, is_visible, updated_at
         FROM page_blocks ORDER BY page_key, position, id`
    );
    res.json({ blocks: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /page-cms/admin/blocks — admin creates an image block.
router.post('/admin/blocks', requireRole('admin'), async (req, res, next) => {
  try {
    const pageKey = (req.body.pageKey || '').trim();
    if (!pageKey) return res.status(400).json({ error: 'Choose which page this block belongs to.' });
    const b = req.body;
    // A block with nothing in it would render as an empty box on the page.
    if (!(b.title || b.subheading || b.description || b.imageUrl)) {
      return res.status(400).json({ error: 'Add at least an image, title, subheading or description.' });
    }
    const result = await pool.query(
      `INSERT INTO page_blocks (page_key, title, subheading, description, image_url, button_label, button_url, position, is_visible)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        pageKey,
        b.title || null, b.subheading || null, b.description || null,
        b.imageUrl || null, b.buttonLabel || null, b.buttonUrl || null,
        Number.isInteger(Number(b.position)) ? Number(b.position) : 0,
        b.isVisible === false ? false : true,
      ]
    );
    res.status(201).json({ block: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// PATCH /page-cms/admin/blocks/:id — admin edits a block.
router.patch('/admin/blocks/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'A valid block id is required.' });
    const map = {
      title: 'title', subheading: 'subheading', description: 'description',
      imageUrl: 'image_url', buttonLabel: 'button_label', buttonUrl: 'button_url',
      position: 'position', isVisible: 'is_visible', pageKey: 'page_key',
    };
    const sets = [];
    const values = [];
    for (const [bodyKey, column] of Object.entries(map)) {
      if (req.body[bodyKey] !== undefined) {
        values.push(req.body[bodyKey]);
        sets.push(`${column} = $${values.length}`);
      }
    }
    if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update.' });
    values.push(id);
    const result = await pool.query(
      `UPDATE page_blocks SET ${sets.join(', ')}, updated_at = now() WHERE id = $${values.length} RETURNING *`,
      values
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'That block no longer exists.' });
    res.json({ block: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /page-cms/admin/blocks/:id — admin removes a block.
router.delete('/admin/blocks/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'A valid block id is required.' });
    await pool.query('DELETE FROM page_blocks WHERE id = $1', [id]);
    logActivity(req.user.id, 'cms_block_deleted', `block ${id}`);
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

// GET /page-cms/admin/ad-slots — admin, every configured ad banner.
router.get('/admin/ad-slots', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query('SELECT slot_key, image_url, link_url, updated_at FROM ad_slots');
    const slots = {};
    result.rows.forEach((r) => { slots[r.slot_key] = { image_url: r.image_url, link_url: r.link_url }; });
    res.json({ adSlots: slots });
  } catch (err) {
    next(err);
  }
});

// PUT /page-cms/admin/ad-slots/:slotKey — admin sets (or clears) a banner.
// An empty image clears the slot, so it falls back to the "reserve this space"
// placeholder — the same revert pattern as the wording CMS.
router.put('/admin/ad-slots/:slotKey', requireRole('admin'), async (req, res, next) => {
  try {
    const slotKey = (req.params.slotKey || '').trim();
    if (!slotKey || slotKey.length > 60) return res.status(400).json({ error: 'A valid slot key is required.' });
    const imageUrl = (req.body.imageUrl || '').trim();
    const linkUrl = (req.body.linkUrl || '').trim() || null;
    // A link is a URL a reader clicks — only http(s), never javascript:.
    if (linkUrl && !/^https?:\/\//i.test(linkUrl)) {
      return res.status(400).json({ error: 'The link must start with http:// or https://' });
    }

    if (!imageUrl) {
      await pool.query('DELETE FROM ad_slots WHERE slot_key = $1', [slotKey]);
      logActivity(req.user.id, 'ad_slot_cleared', slotKey);
      return res.json({ cleared: true, message: 'Banner cleared — the slot shows the reserve-this-space placeholder again.' });
    }
    await pool.query(
      `INSERT INTO ad_slots (slot_key, image_url, link_url)
       VALUES ($1, $2, $3)
       ON CONFLICT (slot_key)
       DO UPDATE SET image_url = EXCLUDED.image_url, link_url = EXCLUDED.link_url, updated_at = now()`,
      [slotKey, imageUrl, linkUrl]
    );
    logActivity(req.user.id, 'ad_slot_set', slotKey);
    res.json({ saved: true, message: 'Banner saved — it is live on the site now.' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
