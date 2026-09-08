const express = require('express');
const { SITE_IMAGES, splitKey, isKnownImageKey, isSafeImageUrl } = require('../utils/siteImages');
const pool = require('../db');
const { requireRole } = require('../middleware/auth');
const { hasPermission } = require('../utils/staffPermissions');
const { logActivity } = require('./activityLog');

const router = express.Router();

// Kept in step with the page_blocks_orientation_check constraint in
// 102_page_block_portrait_links.sql — validated here too so a bad value is a
// clear 400 rather than a database constraint error surfacing as a 500.
const ORIENTATIONS = ['landscape', 'portrait', 'square'];


// Human-facing page catalogue used by the Control Centre. Unknown page keys
// already present in the database are still returned, so this list does not
// lock the CMS to a hard-coded set forever.
const PAGE_CATALOGUE = [
  ['home', 'Homepage'], ['news', 'Latest News'], ['directory', 'Directory'],
  ['gallery', 'Gallery'], ['editions', 'Editions'], ['top10', 'Top 10'],
  ['competitions', 'Competitions'], ['investors', 'Investors'],
  ['brandplacement', 'Marketplace'], ['deafcommunity', 'Deaf Community'], ['nominate', 'Nominate'],
  ['about', 'About'], ['contact', 'Contact'], ['refunds', 'Terms & Policies'],
  ['gate', 'Member Article Gate'],
];

function cleanPageKey(raw) {
  const pageKey = String(raw || '').trim();
  return /^[a-z0-9_-]{1,60}$/i.test(pageKey) ? pageKey : null;
}

function cleanDraftContent(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    if (!/^[a-z0-9_.:-]{1,120}$/i.test(key)) continue;
    const text = value === undefined || value === null ? '' : String(value);
    // Empty means "no override" and is intentionally omitted from publication.
    if (text.trim()) out[key] = text;
  }
  return out;
}

function safeOptionalLink(value) {
  const v = String(value || '').trim();
  if (!v) return null;
  // Existing blocks allow both external links and SPA/internal page targets.
  if (/^(https?:\/\/|\/|#)/i.test(v) || /^[a-z0-9_-]+(?:[/?#].*)?$/i.test(v)) return v;
  return null;
}

function cleanDraftBlocks(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list.slice(0, 200).map((b, index) => {
    const orientation = ORIENTATIONS.includes(b.orientation) ? b.orientation : 'landscape';
    const imageUrl = String(b.image_url || b.imageUrl || '').trim() || null;
    const imageLinkUrl = safeOptionalLink(b.image_link_url || b.imageLinkUrl);
    const buttonUrl = safeOptionalLink(b.button_url || b.buttonUrl);
    return {
      title: String(b.title || '').trim().slice(0, 255) || null,
      subheading: String(b.subheading || '').trim().slice(0, 255) || null,
      description: String(b.description || '').trim() || null,
      image_url: imageUrl,
      button_label: String(b.button_label || b.buttonLabel || '').trim().slice(0, 120) || null,
      button_url: buttonUrl,
      position: Number.isInteger(Number(b.position)) ? Number(b.position) : index,
      is_visible: b.is_visible === false || b.isVisible === false ? false : true,
      orientation,
      image_link_url: imageLinkUrl,
      show_click_hint: (b.show_click_hint === true || b.showClickHint === true) && !!imageLinkUrl,
      click_hint_text: String(b.click_hint_text || b.clickHintText || '').trim() || null,
    };
  }).filter((b) => b.title || b.subheading || b.description || b.image_url);
}

async function livePageState(pageKey, client = pool) {
  const [content, blocks] = await Promise.all([
    client.query(
      `SELECT content_key, value, updated_at FROM page_content WHERE page_key = $1 ORDER BY content_key`,
      [pageKey]
    ),
    client.query(
      `SELECT id, page_key, title, subheading, description, image_url,
              button_label, button_url, position, is_visible, updated_at,
              orientation, image_link_url, show_click_hint, click_hint_text
         FROM page_blocks WHERE page_key = $1 ORDER BY position, id`,
      [pageKey]
    ),
  ]);
  const contentMap = {};
  content.rows.forEach((row) => { contentMap[row.content_key] = row.value; });
  const newestContent = content.rows.reduce((m, r) => !m || new Date(r.updated_at) > new Date(m) ? r.updated_at : m, null);
  const newestBlock = blocks.rows.reduce((m, r) => !m || new Date(r.updated_at) > new Date(m) ? r.updated_at : m, null);
  return {
    content: contentMap,
    blocks: blocks.rows,
    baseState: {
      contentUpdatedAt: newestContent || null,
      blocksUpdatedAt: newestBlock || null,
      contentCount: content.rowCount,
      blockCount: blocks.rowCount,
    },
  };
}

function sameBaseState(a, b) {
  // page_cms_drafts.base_state is PostgreSQL JSONB, which does not preserve
  // object key order. Stringifying the JSONB object can therefore report a
  // false conflict even when every concurrency-guard value still matches.
  const left = a || {};
  const right = b || {};
  const stamp = (value) => value ? new Date(value).toISOString() : null;
  return stamp(left.contentUpdatedAt) === stamp(right.contentUpdatedAt)
    && stamp(left.blocksUpdatedAt) === stamp(right.blocksUpdatedAt)
    && Number(left.contentCount || 0) === Number(right.contentCount || 0)
    && Number(left.blockCount || 0) === Number(right.blockCount || 0);
}

// GET /page-cms — public. One call returns every override and every visible
// block for the whole site, because the magazine is a single-page app that
// switches pages client-side: fetching per page would mean a round trip on
// every navigation.
router.get('/', async (req, res, next) => {
  try {
    const content = await pool.query('SELECT page_key, content_key, value FROM page_content');
    const blocks = await pool.query(
      `SELECT id, page_key, title, subheading, description, image_url,
              button_label, button_url, position,
              orientation, image_link_url, show_click_hint, click_hint_text
         FROM page_blocks
        WHERE is_visible = true
        ORDER BY page_key, position, id`
    );
    // Only banners that are switched on AND inside their schedule window (an
    // unset start/end means "no restriction" on that side). Ordered so the
    // frontend can just render them in sequence for the rotation.
    const ads = await pool.query(
      `SELECT id, slot_key, image_url, link_url, name, cta_text, mobile_image_url,
              animation_effect, transition_duration_ms, display_duration_ms
         FROM ad_slots
        WHERE archived_at IS NULL
          AND is_active = true
          AND (moderation_status IS NULL OR moderation_status = 'approved')
          AND (starts_at IS NULL OR starts_at <= CURRENT_DATE)
          AND (ends_at IS NULL OR ends_at >= CURRENT_DATE)
        ORDER BY slot_key, display_order, id`
    );
    // Shape content as { "home.hero.title": "…" } so the frontend can look up
    // a data-cms attribute directly without walking nested objects.
    const contentMap = {};
    content.rows.forEach((r) => { contentMap[`${r.page_key}.${r.content_key}`] = r.value; });
    const blocksByPage = {};
    blocks.rows.forEach((b) => {
      if (!blocksByPage[b.page_key]) blocksByPage[b.page_key] = [];
      blocksByPage[b.page_key].push(b);
    });
    // Keyed by slot, each an ORDERED ARRAY of currently-active banners (may be
    // empty, one, or several) — the frontend rotates through whatever it gets.
    const adSlots = {};
    ads.rows.forEach((a) => {
      if (!adSlots[a.slot_key]) adSlots[a.slot_key] = [];
      adSlots[a.slot_key].push({
        id: a.id, image_url: a.image_url, link_url: a.link_url,
        name: a.name, cta_text: a.cta_text, mobile_image_url: a.mobile_image_url,
        animation_effect: a.animation_effect,
        transition_duration_ms: a.transition_duration_ms,
        display_duration_ms: a.display_duration_ms,
      });
    });
    res.json({ content: contentMap, blocks: blocksByPage, adSlots });
  } catch (err) {
    next(err);
  }
});


// GET /page-cms/admin/pages — page catalogue plus draft status. This is the
// landing data for the WordPress-like Pages & Layout screen.
router.get('/admin/pages', requireRole('admin'), async (req, res, next) => {
  try {
    const known = new Map(PAGE_CATALOGUE);
    const discovered = await pool.query(
      `SELECT page_key FROM page_content UNION SELECT page_key FROM page_blocks ORDER BY page_key`
    );
    discovered.rows.forEach((r) => { if (!known.has(r.page_key)) known.set(r.page_key, r.page_key.replace(/[-_]/g, ' ')); });
    const drafts = await pool.query('SELECT page_key, updated_at, updated_by FROM page_cms_drafts');
    const draftMap = new Map(drafts.rows.map((r) => [r.page_key, r]));
    res.json({
      pages: Array.from(known, ([pageKey, label]) => ({
        pageKey, label, hasDraft: draftMap.has(pageKey),
        draftUpdatedAt: draftMap.get(pageKey)?.updated_at || null,
        draftUpdatedBy: draftMap.get(pageKey)?.updated_by || null,
      })),
    });
  } catch (err) { next(err); }
});

// GET /page-cms/admin/workspace/:pageKey — returns both live state and the
// staged draft. If no draft exists, the editable workspace starts as an exact
// copy of live state but nothing is persisted until Save Draft is pressed.
router.get('/admin/workspace/:pageKey', requireRole('admin'), async (req, res, next) => {
  try {
    const pageKey = cleanPageKey(req.params.pageKey);
    if (!pageKey) return res.status(400).json({ error: 'A valid page key is required.' });
    const live = await livePageState(pageKey);
    const draft = await pool.query(
      `SELECT page_key, content_json, blocks_json, base_state, updated_at, updated_by
         FROM page_cms_drafts WHERE page_key = $1`, [pageKey]
    );
    const d = draft.rows[0] || null;
    res.json({
      pageKey,
      live,
      hasDraft: !!d,
      draft: d ? {
        content: d.content_json || {}, blocks: d.blocks_json || [],
        baseState: d.base_state || {}, updatedAt: d.updated_at, updatedBy: d.updated_by,
      } : { content: live.content, blocks: live.blocks, baseState: live.baseState },
    });
  } catch (err) { next(err); }
});

// PUT /page-cms/admin/workspace/:pageKey — saves a private draft only. The
// public /page-cms route never reads page_cms_drafts, so this cannot leak live.
router.put('/admin/workspace/:pageKey', requireRole('admin'), async (req, res, next) => {
  try {
    const pageKey = cleanPageKey(req.params.pageKey);
    if (!pageKey) return res.status(400).json({ error: 'A valid page key is required.' });
    const existing = await pool.query('SELECT base_state FROM page_cms_drafts WHERE page_key = $1', [pageKey]);
    const live = await livePageState(pageKey);
    const baseState = existing.rows[0]?.base_state || live.baseState;
    const content = cleanDraftContent(req.body.content);
    const blocks = cleanDraftBlocks(req.body.blocks);
    const result = await pool.query(
      `INSERT INTO page_cms_drafts (page_key, content_json, blocks_json, base_state, updated_by)
       VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5)
       ON CONFLICT (page_key) DO UPDATE
         SET content_json = EXCLUDED.content_json,
             blocks_json = EXCLUDED.blocks_json,
             updated_by = EXCLUDED.updated_by,
             updated_at = now()
       RETURNING updated_at`,
      [pageKey, JSON.stringify(content), JSON.stringify(blocks), JSON.stringify(baseState), req.user.id]
    );
    logActivity(req.user.id, 'cms_draft_saved', pageKey);
    res.json({ saved: true, pageKey, updatedAt: result.rows[0].updated_at, message: 'Draft saved. Nothing on the public page changed.' });
  } catch (err) { next(err); }
});

// POST /page-cms/admin/workspace/:pageKey/publish — atomically replaces the
// live overrides and blocks with the reviewed draft. A concurrency guard stops
// a stale draft from overwriting a live page somebody changed after drafting.
router.post('/admin/workspace/:pageKey/publish', requireRole('admin'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const pageKey = cleanPageKey(req.params.pageKey);
    if (!pageKey) return res.status(400).json({ error: 'A valid page key is required.' });
    await client.query('BEGIN');
    const draftRes = await client.query(
      `SELECT content_json, blocks_json, base_state FROM page_cms_drafts WHERE page_key = $1 FOR UPDATE`,
      [pageKey]
    );
    if (!draftRes.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'There is no saved draft to publish.' });
    }
    const current = await livePageState(pageKey, client);
    const draft = draftRes.rows[0];
    if (!sameBaseState(draft.base_state, current.baseState)) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'The live page changed after this draft was started. Refresh the workspace before publishing so no newer change is overwritten.',
        code: 'CMS_DRAFT_CONFLICT',
      });
    }
    const content = cleanDraftContent(draft.content_json);
    const blocks = cleanDraftBlocks(draft.blocks_json);
    await client.query('DELETE FROM page_content WHERE page_key = $1', [pageKey]);
    for (const [contentKey, value] of Object.entries(content)) {
      await client.query(
        `INSERT INTO page_content (page_key, content_key, value) VALUES ($1, $2, $3)`,
        [pageKey, contentKey, value]
      );
    }
    await client.query('DELETE FROM page_blocks WHERE page_key = $1', [pageKey]);
    for (let i = 0; i < blocks.length; i += 1) {
      const b = blocks[i];
      await client.query(
        `INSERT INTO page_blocks
          (page_key, title, subheading, description, image_url, button_label, button_url,
           position, is_visible, orientation, image_link_url, show_click_hint, click_hint_text)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [pageKey, b.title, b.subheading, b.description, b.image_url, b.button_label, b.button_url,
         i, b.is_visible, b.orientation, b.image_link_url, b.show_click_hint, b.click_hint_text]
      );
    }
    await client.query('DELETE FROM page_cms_drafts WHERE page_key = $1', [pageKey]);
    await client.query('COMMIT');
    logActivity(req.user.id, 'cms_page_published', pageKey);
    res.json({ published: true, pageKey, message: 'Published. The reviewed page changes are now live.' });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore rollback failure */ }
    next(err);
  } finally { client.release(); }
});

router.delete('/admin/workspace/:pageKey', requireRole('admin'), async (req, res, next) => {
  try {
    const pageKey = cleanPageKey(req.params.pageKey);
    if (!pageKey) return res.status(400).json({ error: 'A valid page key is required.' });
    const result = await pool.query('DELETE FROM page_cms_drafts WHERE page_key = $1', [pageKey]);
    if (result.rowCount) logActivity(req.user.id, 'cms_draft_discarded', pageKey);
    res.json({ discarded: !!result.rowCount, message: result.rowCount ? 'Draft discarded. The live page was not changed.' : 'There was no draft to discard.' });
  } catch (err) { next(err); }
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

// GET /page-cms/admin/site-images — admin. The pictures that can be swapped,
// each with whatever is currently set, so the screen can render an upload
// field per image without knowing any of the keys itself.
router.get('/admin/site-images', requireRole('admin'), async (req, res, next) => {
  try {
    const rows = await pool.query('SELECT page_key, content_key, value FROM page_content');
    const current = {};
    rows.rows.forEach((r) => { current[`${r.page_key}.${r.content_key}`] = r.value; });
    res.json({
      images: SITE_IMAGES.map((i) => ({ ...i, value: current[i.key] || null })),
    });
  } catch (err) {
    next(err);
  }
});

// PUT /page-cms/admin/site-images — admin sets or clears one picture.
//
// Deliberately NOT the generic content route: that one takes any key and any
// string, which is right for wording but wrong for something that becomes an
// <img src>. This accepts only keys on the known list and only addresses that
// pass isSafeImageUrl, so a stored value cannot be a javascript: URL waiting
// for a template that forgets to check.
router.put('/admin/site-images', requireRole('admin'), async (req, res, next) => {
  try {
    const key = (req.body.key || '').trim();
    if (!isKnownImageKey(key)) {
      return res.status(404).json({ error: 'That is not a picture this site knows how to change.' });
    }
    const parts = splitKey(key);
    const raw = req.body.value === undefined || req.body.value === null ? '' : String(req.body.value).trim();

    // Empty clears it, matching how the wording editor reverts to built-in copy.
    if (!raw) {
      await pool.query('DELETE FROM page_content WHERE page_key = $1 AND content_key = $2',
        [parts.pageKey, parts.contentKey]);
      logActivity(req.user.id, 'site_image_cleared', key);
      return res.json({ cleared: true, message: 'Removed — that spot on the page is now empty.' });
    }
    if (!isSafeImageUrl(raw)) {
      return res.status(400).json({
        error: 'That does not look like an image address. Upload a file, or paste a link starting with https://',
      });
    }
    await pool.query(
      `INSERT INTO page_content (page_key, content_key, value)
       VALUES ($1, $2, $3)
       ON CONFLICT (page_key, content_key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [parts.pageKey, parts.contentKey, raw]
    );
    logActivity(req.user.id, 'site_image_changed', key);
    res.json({ saved: true, message: 'Saved — the new picture is live on the site.' });
  } catch (err) {
    next(err);
  }
});

// GET /page-cms/admin/blocks — admin, including hidden ones.
router.get('/admin/blocks', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, page_key, title, subheading, description, image_url,
              button_label, button_url, position, is_visible, updated_at,
              orientation, image_link_url, show_click_hint, click_hint_text
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
    const orientation = ORIENTATIONS.includes(b.orientation) ? b.orientation : 'landscape';
    const result = await pool.query(
      `INSERT INTO page_blocks (page_key, title, subheading, description, image_url, button_label, button_url,
                                position, is_visible, orientation, image_link_url, show_click_hint, click_hint_text)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
      [
        pageKey,
        b.title || null, b.subheading || null, b.description || null,
        b.imageUrl || null, b.buttonLabel || null, b.buttonUrl || null,
        Number.isInteger(Number(b.position)) ? Number(b.position) : 0,
        b.isVisible === false ? false : true,
        orientation,
        b.imageLinkUrl || null,
        // A hint with nothing to click would be a lie, so it only sticks if
        // the image actually links somewhere.
        b.showClickHint === true && !!b.imageLinkUrl,
        b.clickHintText || null,
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
      orientation: 'orientation', imageLinkUrl: 'image_link_url',
      showClickHint: 'show_click_hint', clickHintText: 'click_hint_text',
    };
    if (req.body.orientation !== undefined && !ORIENTATIONS.includes(req.body.orientation)) {
      return res.status(400).json({ error: `orientation must be one of: ${ORIENTATIONS.join(', ')}.` });
    }
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

// GET /page-cms/admin/ad-slots — admin, EVERY banner in every slot (active,
// inactive, scheduled-future, expired — the admin needs to see and manage
// all of it, unlike the public endpoint which only returns what's live now).
router.get('/admin/ad-slots', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT a.id, a.slot_key, a.image_url, a.link_url, a.name, a.cta_text, a.mobile_image_url,
              a.display_order, a.is_active, a.starts_at, a.ends_at, a.created_at, a.updated_at,
              a.owner_user_id, a.moderation_status, a.duration_days, a.payment_id,
              a.animation_effect, a.transition_duration_ms, a.display_duration_ms,
              a.campaign_name, a.advertiser_name, a.advertiser_contact, a.advertiser_email,
              COALESCE(a.amount_paid,
                CASE WHEN p.status = 'confirmed' THEN p.amount + COALESCE(p.credit_used, 0) END) AS amount_paid,
              CASE WHEN a.payment_status <> 'not_recorded' THEN a.payment_status
                   WHEN p.status = 'confirmed' THEN 'paid'
                   WHEN p.status = 'pending' THEN 'pending'
                   ELSE a.payment_status END AS payment_status,
              a.internal_notes, a.archived_at,
              COALESCE(stats.impressions, 0)::bigint AS impressions,
              COALESCE(stats.clicks, 0)::bigint AS clicks,
              CASE WHEN COALESCE(stats.impressions,0) > 0
                   THEN ROUND(stats.clicks::numeric / stats.impressions * 100, 2) ELSE 0 END AS ctr,
              u.email AS owner_email
         FROM ad_slots a
         LEFT JOIN users u ON u.id = a.owner_user_id
         LEFT JOIN payments p ON p.id = a.payment_id
         LEFT JOIN LATERAL (
           SELECT COALESCE(SUM(impressions),0) impressions, COALESCE(SUM(clicks),0) clicks
             FROM ad_banner_analytics x WHERE x.ad_slot_id = a.id
         ) stats ON true
        ORDER BY a.archived_at NULLS FIRST, a.slot_key, a.display_order, a.id`
    );
    const slots = {};
    result.rows.forEach((r) => {
      if (!slots[r.slot_key]) slots[r.slot_key] = [];
      slots[r.slot_key].push(r);
    });
    res.json({ adSlots: slots });
  } catch (err) {
    next(err);
  }
});

// Same 8-value vocabulary unplug-popups.js already validates for its own
// entrance-animation dropdown (ALLOWED_ANIM) — one set of effect names
// across the whole site rather than a second one invented here.
const ALLOWED_ANIM = ['none', 'fade', 'fade-up', 'slide-up', 'slide-down', 'slide-left', 'slide-right', 'zoom'];

async function canEditAdFinance(req) {
  if (req.user && req.user.role === 'admin') return true;
  if (req.user && req.user.role === 'staff') return hasPermission(req.user.id, 'finance.manage');
  return false;
}

function validateAdSlotInput(body) {
  const imageUrl = (body.imageUrl || '').trim();
  const linkUrl = (body.linkUrl || '').trim() || null;
  if (!imageUrl) return { error: 'A banner image is required.' };
  // A link is a URL a reader clicks — only http(s), never javascript:.
  if (linkUrl && !/^https?:\/\//i.test(linkUrl)) {
    return { error: 'The link must start with http:// or https://' };
  }
  const displayOrder = Number.isInteger(Number(body.displayOrder)) ? Number(body.displayOrder) : 0;
  const isActive = body.isActive === false ? false : true;
  const startsAt = body.startsAt || null;
  const endsAt = body.endsAt || null;
  const name = (body.name || '').trim().slice(0, 160) || null;
  const ctaText = (body.ctaText || '').trim().slice(0, 40) || null;
  const mobileImageUrl = (body.mobileImageUrl || '').trim() || null;
  const campaignName = (body.campaignName || '').trim().slice(0, 180) || null;
  const advertiserName = (body.advertiserName || body.name || '').trim().slice(0, 180) || null;
  const advertiserContact = (body.advertiserContact || '').trim().slice(0, 180) || null;
  const advertiserEmail = (body.advertiserEmail || '').trim().slice(0, 255) || null;
  if (advertiserEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(advertiserEmail)) return { error: 'Enter a valid advertiser email address.' };
  const rawAmount = body.amountPaid;
  const amountPaid = rawAmount === '' || rawAmount === null || rawAmount === undefined ? null : Number(rawAmount);
  if (amountPaid !== null && (!Number.isFinite(amountPaid) || amountPaid < 0)) return { error: 'Amount paid must be zero or more.' };
  const allowedPayment = ['not_recorded','pending','paid','credited','refunded','complimentary'];
  const paymentStatus = allowedPayment.includes(body.paymentStatus) ? body.paymentStatus : 'not_recorded';
  const internalNotes = (body.internalNotes || '').trim().slice(0, 4000) || null;

  if (body.animationEffect !== undefined && !ALLOWED_ANIM.includes(body.animationEffect)) {
    return { error: `animationEffect must be one of: ${ALLOWED_ANIM.join(', ')}` };
  }
  const animationEffect = ALLOWED_ANIM.includes(body.animationEffect) ? body.animationEffect : 'fade';
  const transitionMs = Number(body.transitionDurationMs);
  const transitionDurationMs = Number.isInteger(transitionMs) && transitionMs > 0 && transitionMs <= 10000 ? transitionMs : 600;
  const displayMs = Number(body.displayDurationMs);
  const displayDurationMs = Number.isInteger(displayMs) && displayMs >= 1000 && displayMs <= 120000 ? displayMs : 5000;

  return {
    imageUrl, linkUrl, displayOrder, isActive, startsAt, endsAt, name, ctaText, mobileImageUrl,
    animationEffect, transitionDurationMs, displayDurationMs,
    campaignName, advertiserName, advertiserContact, advertiserEmail, amountPaid, paymentStatus, internalNotes,
  };
}

// POST /page-cms/admin/ad-slots — admin adds a NEW banner to a slot. A slot
// can hold as many as an admin wants; the public site rotates through
// whichever are currently active and in-schedule.
router.post('/admin/ad-slots', requireRole('admin'), async (req, res, next) => {
  try {
    const slotKey = (req.body.slotKey || '').trim();
    if (!slotKey || slotKey.length > 60) return res.status(400).json({ error: 'A valid slot key is required.' });
    const v = validateAdSlotInput(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    if (!(await canEditAdFinance(req))) {
      v.amountPaid = null;
      v.paymentStatus = 'not_recorded';
    }

    const result = await pool.query(
      `INSERT INTO ad_slots (slot_key, image_url, link_url, display_order, is_active, starts_at, ends_at, name, cta_text, mobile_image_url,
                             animation_effect, transition_duration_ms, display_duration_ms,
                             campaign_name, advertiser_name, advertiser_contact, advertiser_email, amount_paid, payment_status, internal_notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20) RETURNING *`,
      [slotKey, v.imageUrl, v.linkUrl, v.displayOrder, v.isActive, v.startsAt, v.endsAt, v.name, v.ctaText, v.mobileImageUrl,
       v.animationEffect, v.transitionDurationMs, v.displayDurationMs, v.campaignName, v.advertiserName,
       v.advertiserContact, v.advertiserEmail, v.amountPaid, v.paymentStatus, v.internalNotes]
    );
    logActivity(req.user.id, 'ad_slot_added', slotKey);
    res.status(201).json({ banner: result.rows[0], message: 'Banner added — it rotates in live if active and in-schedule.' });
  } catch (err) {
    next(err);
  }
});

// PATCH /page-cms/admin/ad-slots/:id — admin edits one banner (image, link,
// order, active toggle, or schedule window).
router.patch('/admin/ad-slots/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'A valid banner id is required.' });
    const v = validateAdSlotInput(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    if (!(await canEditAdFinance(req))) {
      const existingFinance = await pool.query('SELECT amount_paid, payment_status FROM ad_slots WHERE id = $1', [id]);
      if (existingFinance.rowCount) {
        v.amountPaid = existingFinance.rows[0].amount_paid;
        v.paymentStatus = existingFinance.rows[0].payment_status;
      }
    }

    const result = await pool.query(
      `UPDATE ad_slots
          SET image_url = $1, link_url = $2, display_order = $3, is_active = $4,
              starts_at = $5, ends_at = $6, name = $7, cta_text = $8, mobile_image_url = $9,
              animation_effect = $10, transition_duration_ms = $11, display_duration_ms = $12,
              campaign_name = $13, advertiser_name = $14, advertiser_contact = $15, advertiser_email = $16,
              amount_paid = $17, payment_status = $18, internal_notes = $19, updated_at = now()
        WHERE id = $20 RETURNING *`,
      [v.imageUrl, v.linkUrl, v.displayOrder, v.isActive, v.startsAt, v.endsAt, v.name, v.ctaText, v.mobileImageUrl,
       v.animationEffect, v.transitionDurationMs, v.displayDurationMs, v.campaignName, v.advertiserName,
       v.advertiserContact, v.advertiserEmail, v.amountPaid, v.paymentStatus, v.internalNotes, id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'That banner no longer exists.' });
    logActivity(req.user.id, 'ad_slot_edited', result.rows[0].slot_key);
    res.json({ banner: result.rows[0], message: 'Saved — the change is live now.' });
  } catch (err) {
    next(err);
  }
});

// PATCH /page-cms/admin/ad-slots/:id/archive — safe archive/restore for campaigns.
// Archiving takes a banner off the public site without deleting its campaign
// history or analytics. Permanent DELETE remains as a compatibility endpoint.
router.patch('/admin/ad-slots/:id/archive', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'A valid banner id is required.' });
    const restore = req.body && req.body.restore === true;
    const result = await pool.query(
      `UPDATE ad_slots SET archived_at = ${restore ? 'NULL' : 'now()'}, is_active = ${restore ? 'is_active' : 'false'}, updated_at = now()
        WHERE id = $1 RETURNING id, slot_key, archived_at`, [id]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'That banner no longer exists.' });
    logActivity(req.user.id, restore ? 'ad_campaign_restored' : 'ad_campaign_archived', `banner ${id} · ${result.rows[0].slot_key}`);
    res.json({ archived: !restore, message: restore ? 'Campaign restored. Turn Active on when you are ready to run it.' : 'Campaign archived and removed from rotation.' });
  } catch (err) { next(err); }
});

// DELETE /page-cms/admin/ad-slots/:id — admin removes one banner.
router.delete('/admin/ad-slots/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'A valid banner id is required.' });
    const result = await pool.query('DELETE FROM ad_slots WHERE id = $1 RETURNING slot_key', [id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'That banner no longer exists.' });
    logActivity(req.user.id, 'ad_slot_removed', result.rows[0].slot_key);
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

// PATCH /page-cms/admin/ad-slots/:id/moderate — admin approves or rejects a
// member-submitted (paid) banner. Approve -> goes live within its dates.
// Reject -> hidden, and the amount paid is refunded to the member's account
// credit (their money isn't kept for a banner that never ran).
router.patch('/admin/ad-slots/:id/moderate', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const action = req.body.action;
    if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'action must be "approve" or "reject".' });
    const row = await pool.query('SELECT owner_user_id, payment_id, moderation_status FROM ad_slots WHERE id = $1', [id]);
    if (row.rowCount === 0) return res.status(404).json({ error: 'That banner no longer exists.' });
    const b = row.rows[0];

    if (action === 'approve') {
      await pool.query(`UPDATE ad_slots SET moderation_status = 'approved', is_active = true, updated_at = now() WHERE id = $1`, [id]);
      logActivity(req.user.id, 'ad_banner_approved', `banner ${id}`);
      return res.json({ moderated: 'approved', message: 'Approved — it runs on its scheduled dates.' });
    }

    // Reject: hide it, and refund what was paid (if anything) to account credit.
    await pool.query(`UPDATE ad_slots SET moderation_status = 'rejected', is_active = false, updated_at = now() WHERE id = $1`, [id]);
    let refunded = 0;
    // Only refund on the FIRST rejection of a paid banner (the unique index on
    // account_credits.payment_id also stops any double credit).
    if (b.moderation_status === 'pending_approval' && b.payment_id && b.owner_user_id) {
      const pay = await pool.query(`SELECT amount, credit_used FROM payments WHERE id = $1 AND status = 'confirmed'`, [b.payment_id]);
      if (pay.rowCount > 0) {
        // Refund the full order value (cash paid + any credit that was spent).
        refunded = Number(pay.rows[0].amount) + Number(pay.rows[0].credit_used || 0);
        if (refunded > 0) {
          await pool.query(
            `INSERT INTO account_credits (user_id, amount, reason, note, payment_id, created_by)
             VALUES ($1, $2, 'declined_submission', $3, $4, $5)`,
            [b.owner_user_id, refunded, `Banner #${id} was not approved — full refund to account credit.`, b.payment_id, req.user.id]
          );
        }
      }
    }
    logActivity(req.user.id, 'ad_banner_rejected', `banner ${id}`);
    res.json({ moderated: 'rejected', refunded, message: refunded > 0 ? `Rejected — R${refunded.toFixed(2)} refunded to the member's account credit.` : 'Rejected.' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
