const express = require('express');
const pool = require('../db');
const { requireRole } = require('../middleware/auth');
const { logActivity } = require('./activityLog');

const router = express.Router();

// Central limits — the frontend reads MAX_DESCRIPTION_WORDS / MAX_PROJECT_IMAGES
// from GET /projects/limits so the counter and the server agree on one value.
const MAX_DESCRIPTION_WORDS = 450; // ~3 minutes of spoken English
const MAX_PROJECT_IMAGES = 20;

function wordCount(text) {
  return (String(text || '').trim().match(/\S+/g) || []).length;
}

// Turn a supported YouTube/Instagram URL into a safe embed URL. Returns null for
// anything unsupported — we never accept raw embed HTML from the admin, only a
// URL we recognise and rebuild ourselves.
function buildVideoEmbed(platform, url) {
  const u = String(url || '').trim();
  if (!platform || !u) return { platform: null, url: null, embedUrl: null };
  if (platform === 'youtube') {
    let id = null;
    let m;
    if ((m = u.match(/[?&]v=([\w-]{6,})/))) id = m[1];
    else if ((m = u.match(/youtu\.be\/([\w-]{6,})/))) id = m[1];
    else if ((m = u.match(/youtube\.com\/shorts\/([\w-]{6,})/))) id = m[1];
    else if ((m = u.match(/youtube\.com\/embed\/([\w-]{6,})/))) id = m[1];
    if (!id) return { error: 'Please provide a valid YouTube video link.' };
    return { platform: 'youtube', url: u, embedUrl: `https://www.youtube.com/embed/${id}` };
  }
  if (platform === 'instagram') {
    // Instagram embeds are done client-side from the permalink; we just validate
    // it's a real instagram reel/post URL and normalise it.
    if (!/^https:\/\/(www\.)?instagram\.com\/(reel|reels|p|tv)\/[\w-]+/i.test(u)) {
      return { error: 'Please provide a valid Instagram reel or post link.' };
    }
    const clean = u.split('?')[0].replace(/\/?$/, '/');
    return { platform: 'instagram', url: u, embedUrl: clean };
  }
  return { error: 'Please provide a valid YouTube or Instagram video link.' };
}

// Sponsor destination links: only https website / facebook / instagram, never
// javascript: or other unsafe schemes.
function sanitizeSponsorLink(linkType, linkUrl) {
  const url = String(linkUrl || '').trim();
  if (!url) return { linkUrl: null };
  if (!/^https:\/\//i.test(url)) return { error: 'Sponsor links must start with https://' };
  if (linkType === 'facebook' && !/^https:\/\/(www\.)?facebook\.com\//i.test(url)) {
    return { error: 'Facebook links must point to facebook.com' };
  }
  if (linkType === 'instagram' && !/^https:\/\/(www\.)?instagram\.com\//i.test(url)) {
    return { error: 'Instagram links must point to instagram.com' };
  }
  return { linkUrl: url };
}

async function fetchProjectBundle(projectId, { adminView = false } = {}) {
  const proj = await pool.query('SELECT * FROM projects WHERE id = $1', [projectId]);
  if (proj.rowCount === 0) return null;
  const sponsorWhere = adminView ? '' : 'AND is_active = true';
  const [sponsors, images] = await Promise.all([
    pool.query(`SELECT * FROM project_sponsors WHERE project_id = $1 ${sponsorWhere} ORDER BY display_order, id`, [projectId]),
    pool.query('SELECT * FROM project_images WHERE project_id = $1 ORDER BY display_order, id', [projectId]),
  ]);
  return { project: proj.rows[0], sponsors: sponsors.rows, images: images.rows };
}

function coverOf(images) {
  const cover = images.find((i) => i.is_cover) || images[0];
  return cover ? cover.image_url : null;
}

// ————————————————————————————————— PUBLIC —————————————————————————————————

// GET /projects/limits — the shared limits, so the frontend can't drift.
router.get('/limits', (req, res) => {
  res.json({ maxDescriptionWords: MAX_DESCRIPTION_WORDS, maxImages: MAX_PROJECT_IMAGES });
});

// GET /projects — published projects for the Investors listing.
router.get('/', async (req, res, next) => {
  try {
    const rows = await pool.query(
      `SELECT p.id, p.title, p.description, p.featured,
              (SELECT image_url FROM project_images pi WHERE pi.project_id = p.id ORDER BY pi.is_cover DESC, pi.display_order, pi.id LIMIT 1) AS cover_image_url,
              (SELECT COUNT(*) FROM project_images pi WHERE pi.project_id = p.id) AS image_count
         FROM projects p
        WHERE p.status = 'published'
        ORDER BY p.featured DESC, p.display_order, p.id DESC`
    );
    res.json({ projects: rows.rows });
  } catch (err) { next(err); }
});

// GET /projects/:id — full published project (title, description, sponsors,
// video, gallery). Admins can view any status through the admin endpoint below.
router.get('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid project id.' });
    const bundle = await fetchProjectBundle(id);
    if (!bundle || bundle.project.status !== 'published') {
      return res.status(404).json({ error: 'Project not found.' });
    }
    res.json({ ...bundle, coverImageUrl: coverOf(bundle.images) });
  } catch (err) { next(err); }
});

// ————————————————————————————————— ADMIN —————————————————————————————————

// GET /projects/admin/all — every project, any status, with counts for the table.
router.get('/admin/all', requireRole('admin'), async (req, res, next) => {
  try {
    const rows = await pool.query(
      `SELECT p.id, p.title, p.status, p.featured, p.display_order, p.video_platform,
              p.updated_at, p.published_at,
              (SELECT COUNT(*) FROM project_sponsors s WHERE s.project_id = p.id) AS sponsor_count,
              (SELECT COUNT(*) FROM project_images i WHERE i.project_id = p.id) AS image_count,
              (SELECT image_url FROM project_images pi WHERE pi.project_id = p.id ORDER BY pi.is_cover DESC, pi.display_order, pi.id LIMIT 1) AS cover_image_url
         FROM projects p
        ORDER BY p.status = 'archived', p.featured DESC, p.display_order, p.id DESC`
    );
    res.json({ projects: rows.rows, maxDescriptionWords: MAX_DESCRIPTION_WORDS, maxImages: MAX_PROJECT_IMAGES });
  } catch (err) { next(err); }
});

// GET /projects/admin/:id — full project incl. inactive sponsors, for the editor.
router.get('/admin/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const bundle = await fetchProjectBundle(id, { adminView: true });
    if (!bundle) return res.status(404).json({ error: 'Project not found.' });
    res.json({ ...bundle, coverImageUrl: coverOf(bundle.images) });
  } catch (err) { next(err); }
});

// POST /projects/admin — create a project (starts as draft).
router.post('/admin', requireRole('admin'), async (req, res, next) => {
  try {
    const title = (req.body.title || '').trim();
    if (!title) return res.status(400).json({ error: 'A project title is required.' });
    const description = String(req.body.description || '');
    if (wordCount(description) > MAX_DESCRIPTION_WORDS) {
      return res.status(400).json({ error: `Description is too long (max ${MAX_DESCRIPTION_WORDS} words / ~3 minutes).` });
    }
    const result = await pool.query(
      `INSERT INTO projects (title, description, display_order, created_by)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [title, description, Number(req.body.displayOrder) || 0, req.user.id]
    );
    logActivity(req.user.id, 'project_created', title);
    res.status(201).json({ project: result.rows[0] });
  } catch (err) { next(err); }
});

// PATCH /projects/admin/:id — update project info / status / featured / video.
router.patch('/admin/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid project id.' });
    const b = req.body;
    const sets = [];
    const values = [];
    const push = (col, val) => { values.push(val); sets.push(`${col} = $${values.length}`); };

    if (b.title !== undefined) {
      if (!String(b.title).trim()) return res.status(400).json({ error: 'Title cannot be empty.' });
      push('title', String(b.title).trim());
    }
    if (b.description !== undefined) {
      if (wordCount(b.description) > MAX_DESCRIPTION_WORDS) {
        return res.status(400).json({ error: `Description is too long (max ${MAX_DESCRIPTION_WORDS} words / ~3 minutes).` });
      }
      push('description', String(b.description));
    }
    if (b.displayOrder !== undefined) push('display_order', Number(b.displayOrder) || 0);
    if (b.featured !== undefined) push('featured', !!b.featured);
    if (b.seoTitle !== undefined) push('seo_title', String(b.seoTitle || '').slice(0, 200) || null);
    if (b.metaDescription !== undefined) push('meta_description', String(b.metaDescription || '').slice(0, 400) || null);

    if (b.status !== undefined) {
      if (!['draft', 'published', 'unpublished', 'archived'].includes(b.status)) {
        return res.status(400).json({ error: 'Invalid status.' });
      }
      // Publishing enforces the description limit too (belt and braces).
      if (b.status === 'published') {
        const desc = b.description !== undefined
          ? b.description
          : (await pool.query('SELECT description FROM projects WHERE id = $1', [id])).rows[0]?.description;
        if (wordCount(desc) > MAX_DESCRIPTION_WORDS) {
          return res.status(400).json({ error: `Shorten the description to under ${MAX_DESCRIPTION_WORDS} words before publishing.` });
        }
        push('published_at', new Date());
      }
      push('status', b.status);
    }

    if (b.videoPlatform !== undefined || b.videoUrl !== undefined) {
      const platform = b.videoPlatform || null;
      if (!platform || platform === 'none') {
        push('video_platform', null); push('video_url', null); push('video_embed_url', null);
      } else {
        const v = buildVideoEmbed(platform, b.videoUrl);
        if (v.error) return res.status(400).json({ error: v.error });
        push('video_platform', v.platform); push('video_url', v.url); push('video_embed_url', v.embedUrl);
      }
    }

    if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update.' });
    values.push(id);
    const result = await pool.query(
      `UPDATE projects SET ${sets.join(', ')}, updated_at = now() WHERE id = $${values.length} RETURNING *`,
      values
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Project not found.' });
    logActivity(req.user.id, 'project_updated', result.rows[0].title);
    res.json({ project: result.rows[0] });
  } catch (err) { next(err); }
});

// DELETE /projects/admin/:id — permanent delete (sponsors/images cascade).
router.delete('/admin/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const result = await pool.query('DELETE FROM projects WHERE id = $1 RETURNING title', [id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Project not found.' });
    logActivity(req.user.id, 'project_deleted', result.rows[0].title);
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

// ————————————————————————————————— SPONSORS —————————————————————————————————

router.post('/admin/:id/sponsors', requireRole('admin'), async (req, res, next) => {
  try {
    const projectId = Number(req.params.id);
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'A sponsor name is required.' });
    const linkType = ['website', 'facebook', 'instagram'].includes(req.body.linkType) ? req.body.linkType : 'website';
    const link = sanitizeSponsorLink(linkType, req.body.linkUrl);
    if (link.error) return res.status(400).json({ error: link.error });
    const result = await pool.query(
      `INSERT INTO project_sponsors (project_id, name, logo_url, link_type, link_url, display_order, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [projectId, name, (req.body.logoUrl || '').trim() || null, linkType, link.linkUrl,
        Number(req.body.displayOrder) || 0, req.body.isActive === false ? false : true]
    );
    logActivity(req.user.id, 'project_sponsor_added', name);
    res.status(201).json({ sponsor: result.rows[0] });
  } catch (err) { next(err); }
});

router.patch('/admin/sponsors/:sid', requireRole('admin'), async (req, res, next) => {
  try {
    const sid = Number(req.params.sid);
    const b = req.body;
    const sets = [];
    const values = [];
    const push = (col, val) => { values.push(val); sets.push(`${col} = $${values.length}`); };
    if (b.name !== undefined) { if (!String(b.name).trim()) return res.status(400).json({ error: 'Sponsor name cannot be empty.' }); push('name', String(b.name).trim()); }
    if (b.logoUrl !== undefined) push('logo_url', String(b.logoUrl || '').trim() || null);
    const linkType = b.linkType !== undefined ? (['website', 'facebook', 'instagram'].includes(b.linkType) ? b.linkType : 'website') : undefined;
    if (linkType !== undefined) push('link_type', linkType);
    if (b.linkUrl !== undefined) {
      const link = sanitizeSponsorLink(linkType || 'website', b.linkUrl);
      if (link.error) return res.status(400).json({ error: link.error });
      push('link_url', link.linkUrl);
    }
    if (b.displayOrder !== undefined) push('display_order', Number(b.displayOrder) || 0);
    if (b.isActive !== undefined) push('is_active', !!b.isActive);
    if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update.' });
    values.push(sid);
    const result = await pool.query(`UPDATE project_sponsors SET ${sets.join(', ')}, updated_at = now() WHERE id = $${values.length} RETURNING *`, values);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Sponsor not found.' });
    res.json({ sponsor: result.rows[0] });
  } catch (err) { next(err); }
});

router.delete('/admin/sponsors/:sid', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query('DELETE FROM project_sponsors WHERE id = $1 RETURNING name', [Number(req.params.sid)]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Sponsor not found.' });
    logActivity(req.user.id, 'project_sponsor_removed', result.rows[0].name);
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

// ————————————————————————————————— IMAGES —————————————————————————————————

// POST /projects/admin/:id/images — attach an already-uploaded image URL to the
// project. Enforces the hard 20-image limit server-side.
router.post('/admin/:id/images', requireRole('admin'), async (req, res, next) => {
  try {
    const projectId = Number(req.params.id);
    const imageUrl = (req.body.imageUrl || '').trim();
    if (!imageUrl) return res.status(400).json({ error: 'An image URL is required.' });
    const count = await pool.query('SELECT COUNT(*) FROM project_images WHERE project_id = $1', [projectId]);
    if (Number(count.rows[0].count) >= MAX_PROJECT_IMAGES) {
      return res.status(400).json({ error: `Maximum of ${MAX_PROJECT_IMAGES} project images reached.` });
    }
    const order = await pool.query('SELECT COALESCE(MAX(display_order), -1) + 1 AS next FROM project_images WHERE project_id = $1', [projectId]);
    const result = await pool.query(
      `INSERT INTO project_images (project_id, image_url, alt_text, caption, display_order)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [projectId, imageUrl, (req.body.altText || '').trim() || null, (req.body.caption || '').trim() || null, order.rows[0].next]
    );
    logActivity(req.user.id, 'project_image_uploaded', `project ${projectId}`);
    res.status(201).json({ image: result.rows[0] });
  } catch (err) { next(err); }
});

router.patch('/admin/images/:iid', requireRole('admin'), async (req, res, next) => {
  try {
    const iid = Number(req.params.iid);
    const b = req.body;
    // Setting a cover clears any other cover on the same project first.
    if (b.isCover === true) {
      const img = await pool.query('SELECT project_id FROM project_images WHERE id = $1', [iid]);
      if (img.rowCount === 0) return res.status(404).json({ error: 'Image not found.' });
      await pool.query('UPDATE project_images SET is_cover = false WHERE project_id = $1', [img.rows[0].project_id]);
    }
    const sets = [];
    const values = [];
    const push = (col, val) => { values.push(val); sets.push(`${col} = $${values.length}`); };
    if (b.caption !== undefined) push('caption', String(b.caption || '').slice(0, 255) || null);
    if (b.altText !== undefined) push('alt_text', String(b.altText || '').slice(0, 255) || null);
    if (b.displayOrder !== undefined) push('display_order', Number(b.displayOrder) || 0);
    if (b.isCover !== undefined) push('is_cover', !!b.isCover);
    if (b.imageUrl !== undefined && String(b.imageUrl).trim()) push('image_url', String(b.imageUrl).trim());
    if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update.' });
    values.push(iid);
    const result = await pool.query(`UPDATE project_images SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`, values);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Image not found.' });
    res.json({ image: result.rows[0] });
  } catch (err) { next(err); }
});

router.delete('/admin/images/:iid', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query('DELETE FROM project_images WHERE id = $1 RETURNING project_id', [Number(req.params.iid)]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Image not found.' });
    logActivity(req.user.id, 'project_image_removed', `project ${result.rows[0].project_id}`);
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

// POST /projects/admin/:id/reorder-images — body { order: [imageId, ...] }.
router.post('/admin/:id/reorder-images', requireRole('admin'), async (req, res, next) => {
  try {
    const projectId = Number(req.params.id);
    const order = Array.isArray(req.body.order) ? req.body.order : [];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (let i = 0; i < order.length; i++) {
        await client.query('UPDATE project_images SET display_order = $1 WHERE id = $2 AND project_id = $3', [i, Number(order[i]), projectId]);
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    res.json({ reordered: true });
  } catch (err) { next(err); }
});

module.exports = router;
