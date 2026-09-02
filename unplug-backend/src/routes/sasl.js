const express = require('express');
const pool = require('../db');
const { requireRole } = require('../middleware/auth');
const { resolveAndBuildVideoEmbed } = require('../utils/videoEmbed');
const { logActivity } = require('./activityLog');

const router = express.Router();

// ---------------------------------------------------------------------------
// South African Sign Language, as signed video.
//
// SASL IS NOT A WRITTEN LANGUAGE, so there is nothing here that translates
// text. This is a register of videos of a person signing, with captions,
// attached to an article or to a standing page.
//
// Videos come from the platforms the rest of the site already supports —
// YouTube, TikTok, Instagram, Google Drive — through the same video parser
// used by articles and projects. That keeps hosting free and means one set of
// rules about what a video link may be, rather than a second set here that
// drifts. Short vt/vm.tiktok.com links resolve here exactly as they do on an
// article, which is the whole point of there being one parser and not three.
// ---------------------------------------------------------------------------

const TARGET_TYPES = ['article', 'page'];

async function parseBody(body) {
  const targetType = TARGET_TYPES.includes(body.targetType) ? body.targetType : null;
  if (!targetType) return { error: 'targetType must be "article" or "page".' };

  const targetId = String(body.targetId == null ? '' : body.targetId).trim().slice(0, 80);
  if (!targetId) return { error: 'A targetId is required.' };
  // An article target is a number; a page target is a page name. Checking each
  // in its own shape stops "article 7; DROP" ever looking like a valid id.
  if (targetType === 'article' && !/^\d+$/.test(targetId)) {
    return { error: 'For an article, targetId must be the article id.' };
  }
  if (targetType === 'page' && !/^[a-z0-9-]+$/.test(targetId)) {
    return { error: 'For a page, targetId must be the page name, like "deafcommunity".' };
  }

  const video = await resolveAndBuildVideoEmbed(body.videoUrl);
  if (video.error) return { error: video.error };
  if (!video.url) return { error: 'A link to the signed video is required.' };

  // Captions are stored as WebVTT text. Anything that is not cue text is
  // refused rather than quietly saved and then failing silently in the player.
  let captions = body.captionsVtt == null ? null : String(body.captionsVtt).trim();
  if (captions) {
    if (captions.length > 200000) return { error: 'Those captions are too long to store.' };
    if (!/^WEBVTT/.test(captions)) {
      return { error: 'Captions must be a WebVTT file — the text has to start with the word WEBVTT.' };
    }
  } else {
    captions = null;
  }

  // The same rule as the publish route, applied here too. Without this, a
  // POST carrying isPublished:true would put an uncaptioned video in front of
  // readers without ever touching the route that checks for captions.
  if (body.isPublished === true && !captions) {
    return {
      error: 'Add captions before publishing. A signed video without captions leaves out deaf people who do not sign, and anyone watching without sound.',
    };
  }

  return {
    targetType,
    targetId,
    videoUrl: video.url,
    embedUrl: video.embedUrl || null,
    platform: video.platform || null,
    posterUrl: video.thumbnailUrl || null,
    captionsVtt: captions,
    signerName: (body.signerName || '').trim().slice(0, 160) || null,
    note: (body.note || '').trim().slice(0, 300) || null,
    isPublished: body.isPublished === true,
    warning: video.warning || null,
  };
}

// ---------------------------------------------------------------------------
// GET /sasl?targetType=article&targetId=12 — public.
//
// PUBLISHED ONLY. A half-recorded video must not appear on a live article
// because somebody saved a draft row.
// ---------------------------------------------------------------------------
router.get('/', async (req, res, next) => {
  try {
    const targetType = TARGET_TYPES.includes(req.query.targetType) ? req.query.targetType : null;
    const targetId = String(req.query.targetId || '').trim().slice(0, 80);
    if (!targetType || !targetId) {
      return res.json({ video: null });
    }
    const result = await pool.query(
      `SELECT id, target_type, target_id, video_url, embed_url, platform, poster_url,
              captions_vtt, signer_name, note
         FROM sasl_videos
        WHERE target_type = $1 AND target_id = $2 AND is_published = true`,
      [targetType, targetId]
    );
    res.json({ video: result.rows[0] || null });
  } catch (err) {
    next(err);
  }
});

// GET /sasl/all — public. Everything published, so a "watch in SASL" index can
// be built without one request per article.
router.get('/all', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT s.id, s.target_type, s.target_id, s.video_url, s.embed_url, s.platform,
              s.poster_url, s.signer_name, s.note,
              CASE WHEN s.target_type = 'article' THEN a.title ELSE NULL END AS article_title
         FROM sasl_videos s
         LEFT JOIN articles a
                ON s.target_type = 'article'
               AND a.id = NULLIF(s.target_id, '')::integer
               AND a.status = 'approved'
        WHERE s.is_published = true
        ORDER BY s.updated_at DESC`
    );
    res.json({ videos: result.rows });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------- admin

router.get('/admin/all', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT s.*, CASE WHEN s.target_type = 'article' THEN a.title ELSE NULL END AS article_title
         FROM sasl_videos s
         LEFT JOIN articles a
                ON s.target_type = 'article' AND a.id = NULLIF(s.target_id, '')::integer
        ORDER BY s.updated_at DESC`
    );
    res.json({ videos: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /sasl/admin — create or replace the video for a target.
//
// UPSERT, deliberately. There is one signed video per thing; a second row for
// the same article would be an editorial accident, and making the admin delete
// the old one first is a step that exists only to serve the schema.
router.post('/admin', requireRole('admin'), async (req, res, next) => {
  try {
    const parsed = await parseBody(req.body || {});
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const result = await pool.query(
      `INSERT INTO sasl_videos
         (target_type, target_id, video_url, embed_url, platform, poster_url,
          captions_vtt, signer_name, note, is_published)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (target_type, target_id) DO UPDATE
         SET video_url = EXCLUDED.video_url,
             embed_url = EXCLUDED.embed_url,
             platform = EXCLUDED.platform,
             poster_url = EXCLUDED.poster_url,
             captions_vtt = EXCLUDED.captions_vtt,
             signer_name = EXCLUDED.signer_name,
             note = EXCLUDED.note,
             is_published = EXCLUDED.is_published,
             updated_at = now()
       RETURNING *`,
      [parsed.targetType, parsed.targetId, parsed.videoUrl, parsed.embedUrl, parsed.platform,
       parsed.posterUrl, parsed.captionsVtt, parsed.signerName, parsed.note, parsed.isPublished]
    );
    await logActivity(req.user.id, 'sasl_saved',
      `Signed video for ${parsed.targetType} ${parsed.targetId}`);
    res.status(201).json({ video: result.rows[0], warning: parsed.warning });
  } catch (err) {
    next(err);
  }
});

router.patch('/admin/:id/publish', requireRole('admin'), async (req, res, next) => {
  try {
    const publish = req.body && req.body.isPublished === true;
    // Publishing without captions is refused. A signed video with no captions
    // excludes every deaf person who does not sign, and every hearing person
    // watching with the sound off — which is most of them. Saving a draft
    // without captions is fine; putting one in front of readers is not.
    if (publish) {
      const row = await pool.query('SELECT captions_vtt FROM sasl_videos WHERE id = $1', [req.params.id]);
      if (row.rows.length === 0) return res.status(404).json({ error: 'Not found.' });
      if (!row.rows[0].captions_vtt) {
        return res.status(400).json({
          error: 'Add captions before publishing. A signed video without captions leaves out deaf people who do not sign, and anyone watching without sound.',
        });
      }
    }
    const result = await pool.query(
      `UPDATE sasl_videos SET is_published = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [publish, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found.' });
    await logActivity(req.user.id, publish ? 'sasl_published' : 'sasl_unpublished',
      `Signed video #${req.params.id}`);
    res.json({ video: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

router.delete('/admin/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query('DELETE FROM sasl_videos WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found.' });
    await logActivity(req.user.id, 'sasl_deleted', `Signed video #${req.params.id}`);
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
