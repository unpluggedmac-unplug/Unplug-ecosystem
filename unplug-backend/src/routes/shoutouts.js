const express = require('express');
const pool = require('../db');
const { EVENTS, trackAsync } = require('../utils/marketingEvents');
const { parseSocialHandle } = require('../utils/socialHandle');
const { publicSubmitLimiter } = require('../middleware/rateLimit');
const { spamCheck } = require('../middleware/spamCheck');
const honeypot = require('../middleware/honeypot');
const { requireRole } = require('../middleware/auth');
const { recordParticipationAsync } = require('../utils/participation');
const uploads = require('./uploads');
const {
  BRAND_LINE,
  RETURN_LINE,
  WEBSITE,
  lockedMessage,
  defaultShareCaption,
  shareSlug,
  renderShoutoutPngs,
} = require('../utils/shoutoutGraphics');

const router = express.Router();
const PRODUCTION_SITE = 'https://www.unplugnews.com';
const ALLOWED_EVENTS = new Set([
  'shoutout_view',
  'shoutout_share_open',
  'shoutout_share_facebook',
  'shoutout_share_whatsapp',
  'shoutout_share_instagram_native',
  'shoutout_share_linkedin',
  'shoutout_share_x',
  'shoutout_copy_link',
  'shoutout_download_portrait',
  'shoutout_download_square',
  'shoutout_download_og',
  'shoutout_nominate_click',
]);

function siteOrigin() {
  const raw = String(process.env.SITE_URL || process.env.PUBLIC_SITE_URL || PRODUCTION_SITE).trim().replace(/\/+$/, '');
  return /^https:\/\//i.test(raw) ? raw : PRODUCTION_SITE;
}

function shareUrlFor(slug) {
  return `${siteOrigin()}/shout-out/${encodeURIComponent(slug)}`;
}

function validDateKey(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const d = new Date(`${text}T00:00:00Z`);
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== text) return null;
  return text;
}

function cleanName(value) {
  const name = String(value || '').trim().replace(/\s+/g, ' ');
  if (!name || name.length > 200) return null;
  return name;
}

function publicPayload(row) {
  if (!row) return null;
  const slug = row.share_slug || shareSlug(String(row.shoutout_date).slice(0, 10), row.recipient_name);
  const shareUrl = shareUrlFor(slug);
  return {
    id: String(row.shoutout_date).slice(0, 10),
    name: row.recipient_name,
    recipientName: row.recipient_name,
    message: lockedMessage(row.recipient_name),
    brandLine: BRAND_LINE,
    returnLine: RETURN_LINE,
    website: WEBSITE,
    date: String(row.shoutout_date).slice(0, 10),
    featureDate: String(row.shoutout_date).slice(0, 10),
    fromNomination: Boolean(row.nomination_id),
    templateVersion: row.template_version || 'v1',
    mascotPoseKey: row.mascot_pose_key || 'power-up',
    shareSlug: slug,
    shareUrl,
    shareCaption: row.share_caption || defaultShareCaption(row.recipient_name, shareUrl),
    imagePortraitUrl: row.image_portrait_url || null,
    imageSquareUrl: row.image_square_url || null,
    imageOgUrl: row.image_og_url || null,
    assetsReady: row.asset_status === 'ready' && Boolean(row.image_portrait_url && row.image_square_url && row.image_og_url),
    publishedAt: row.published_at || null,
  };
}

async function readSchedule(whereSql, params) {
  const result = await pool.query(
    `SELECT s.shoutout_date, s.nomination_id, s.fallback_name, s.recipient_name,
            s.template_version, s.mascot_pose_key, s.share_slug, s.share_caption,
            s.image_portrait_url, s.image_square_url, s.image_og_url,
            s.asset_status, s.asset_error, s.assets_generated_at, s.published_at,
            s.created_at, s.updated_at
       FROM shoutout_schedule s
      WHERE ${whereSql}
      LIMIT 1`,
    params
  );
  return result.rows[0] || null;
}

function automaticPoseForDate(dateKey) {
  const d = new Date(`${dateKey}T00:00:00Z`);
  const start = Date.UTC(d.getUTCFullYear(), 0, 0);
  const day = Math.floor((d.getTime() - start) / 86400000);
  return ['power-up', 'megaphone-pointing', 'spark-wave'][day % 3];
}

async function ensureSlug(row) {
  if (row.share_slug) return row;
  const dateKey = String(row.shoutout_date).slice(0, 10);
  const slug = shareSlug(dateKey, row.recipient_name);
  const updated = await pool.query(
    `UPDATE shoutout_schedule
        SET share_slug = $2, updated_at = now()
      WHERE shoutout_date = $1
      RETURNING *`,
    [dateKey, slug]
  );
  return updated.rows[0];
}

async function generateAndStoreAssets(row) {
  row = await ensureSlug(row);
  if (row.asset_status === 'ready' && row.image_portrait_url && row.image_square_url && row.image_og_url) {
    // A future scheduled post becomes published automatically on its feature
    // date, without re-rendering the already verified image set.
    if (!row.published_at) {
      const promoted = await pool.query(
        `UPDATE shoutout_schedule
            SET published_at = CASE WHEN shoutout_date <= CURRENT_DATE THEN now() ELSE published_at END,
                updated_at = now()
          WHERE shoutout_date = $1
          RETURNING *`,
        [row.shoutout_date]
      );
      return promoted.rows[0];
    }
    return row;
  }

  await pool.query(
    `UPDATE shoutout_schedule
        SET asset_status = 'generating', asset_error = NULL, updated_at = now()
      WHERE shoutout_date = $1`,
    [row.shoutout_date]
  );

  try {
    if (!uploads.supabaseConfigured) {
      throw new Error('Persistent R2/Supabase public object storage is not configured.');
    }
    const rendered = await renderShoutoutPngs({
      recipientName: row.recipient_name,
      mascotPoseKey: row.mascot_pose_key || 'power-up',
    });
    const base = `shoutouts/${row.share_slug}`;
    // Exact immutable keys: rendering the same record twice replaces only its
    // own three files, never another day's artwork.
    const [portraitUrl, squareUrl, ogUrl] = await Promise.all([
      uploads.putPublicObject(`${base}-portrait.png`, rendered.portrait, 'image/png'),
      uploads.putPublicObject(`${base}-square.png`, rendered.square, 'image/png'),
      uploads.putPublicObject(`${base}-og.png`, rendered.og, 'image/png'),
    ]);

    const ready = await pool.query(
      `UPDATE shoutout_schedule
          SET image_portrait_url = $2,
              image_square_url = $3,
              image_og_url = $4,
              asset_status = 'ready',
              asset_error = NULL,
              assets_generated_at = now(),
              published_at = CASE WHEN shoutout_date <= CURRENT_DATE THEN COALESCE(published_at, now()) ELSE published_at END,
              updated_at = now()
        WHERE shoutout_date = $1
        RETURNING *`,
      [row.shoutout_date, portraitUrl, squareUrl, ogUrl]
    );
    return ready.rows[0];
  } catch (err) {
    await pool.query(
      `UPDATE shoutout_schedule
          SET asset_status = 'failed', asset_error = $2, updated_at = now()
        WHERE shoutout_date = $1`,
      [row.shoutout_date, String(err.message || err).slice(0, 1200)]
    ).catch(() => {});
    throw err;
  }
}

async function materializeToday() {
  // 1. Lock in the next approved nomination for today. recipient_name is
  // copied onto the schedule so that later nomination edits cannot rewrite a
  // historical share permalink.
  await pool.query(
    `INSERT INTO shoutout_schedule
       (shoutout_date, nomination_id, recipient_name, mascot_pose_key)
     SELECT CURRENT_DATE, n.id, n.nominee_name,
            CASE MOD(EXTRACT(DOY FROM CURRENT_DATE)::int, 3)
              WHEN 0 THEN 'power-up'
              WHEN 1 THEN 'megaphone-pointing'
              ELSE 'spark-wave'
            END
       FROM shoutout_nominations n
      WHERE n.status = 'approved'
        AND n.available_from <= CURRENT_DATE
        AND NOT EXISTS (SELECT 1 FROM shoutout_schedule s WHERE s.nomination_id = n.id)
      ORDER BY n.created_at ASC
      LIMIT 1
      ON CONFLICT (shoutout_date) DO NOTHING`
  );

  // 2. If the queue is empty, use the existing deterministic fallback pool.
  await pool.query(
    `INSERT INTO shoutout_schedule
       (shoutout_date, fallback_name, recipient_name, mascot_pose_key)
     SELECT CURRENT_DATE, f.name, f.name,
            CASE MOD(EXTRACT(DOY FROM CURRENT_DATE)::int, 3)
              WHEN 0 THEN 'power-up'
              WHEN 1 THEN 'megaphone-pointing'
              ELSE 'spark-wave'
            END
       FROM shoutout_fallbacks f
      WHERE (SELECT COUNT(*) FROM shoutout_fallbacks) > 0
      ORDER BY f.id
      OFFSET (
        EXTRACT(DOY FROM CURRENT_DATE)::int
        % GREATEST((SELECT COUNT(*) FROM shoutout_fallbacks), 1)
      )
      LIMIT 1
      ON CONFLICT (shoutout_date) DO NOTHING`
  );

  let row = await readSchedule('s.shoutout_date = CURRENT_DATE', []);
  if (!row) return null;
  row = await ensureSlug(row);

  // Rendering is idempotent and happens only while the record is not ready.
  // Normal visitors therefore read three already-stored URLs; they never pay
  // the cost of canvas/Sharp work on every page load.
  try {
    row = await generateAndStoreAssets(row);
  } catch (err) {
    // Keep the live HTML shout-out readable if storage is temporarily down,
    // but do NOT mark it published. Share/download controls can disable until
    // the three assets exist, while the next request can retry generation.
    console.error('[daily shout-out] social asset generation failed:', err.message);
    row = await readSchedule('s.shoutout_date = CURRENT_DATE', []);
  }
  return row;
}

// GET /shoutouts/today — public current view. Tomorrow gets a new schedule
// row; today's immutable share_slug and generated artwork remain stored.
router.get('/today', async (req, res, next) => {
  try {
    const row = await materializeToday();
    if (!row) return res.json({ shoutout: null });
    res.json({ shoutout: publicPayload(row) });
  } catch (err) {
    next(err);
  }
});

// GET /shoutouts/share/:slug — public immutable record used by Cloudflare's
// server-rendered /shout-out/:slug page. Future scheduled records stay hidden.
router.get('/share/:slug', async (req, res, next) => {
  try {
    let row = await readSchedule('s.share_slug = $1 AND s.shoutout_date <= CURRENT_DATE', [String(req.params.slug || '')]);
    if (!row) return res.status(404).json({ error: 'Shout-out not found.' });
    if (row.asset_status !== 'ready') {
      try { row = await generateAndStoreAssets(row); }
      catch (err) {
        return res.status(503).json({ error: 'This shout-out artwork is temporarily unavailable. Please try again.' });
      }
    }
    res.json({ shoutout: publicPayload(row) });
  } catch (err) {
    next(err);
  }
});

// POST /shoutouts/nominate — public. Anyone can suggest a name+surname for a
// future shoutout. It remains pending until admin approval.
router.post('/nominate', publicSubmitLimiter, honeypot, spamCheck('shout-out nomination'), async (req, res, next) => {
  try {
    const { nomineeName, message, email, nomineeSocial } = req.body;
    const name = cleanName(nomineeName);
    if (!name) return res.status(400).json({ error: 'A valid name and surname are required.' });

    const social = parseSocialHandle(nomineeSocial);
    await pool.query(
      `INSERT INTO shoutout_nominations
         (nominee_name, message, submitted_by_email, nominee_social, nominee_social_url)
       VALUES ($1, $2, $3, $4, $5)`,
      [name, String(message || '').trim() || null, String(email || '').trim() || null,
        social.text, social.url]
    );

    if (req.user) recordParticipationAsync(req.user.id, 'recognition_nominate');
    const nominatorEmail = String(email || '').trim();
    if (nominatorEmail) {
      trackAsync(EVENTS.NOMINATOR_JOINED, {
        email: nominatorEmail,
        payload: { NOMINEE_NAME: name, source: 'nomination' },
      });
    }

    res.status(201).json({
      message: 'Thanks! Your shout-out nomination has been submitted for review. Approved nominations go into a queue and appear about a week later.',
    });
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------------------
// Control Centre v2 — content.manage through the existing staff permission
// inference for /shoutouts. Super Admin retains unrestricted access.
// -------------------------------------------------------------------------
router.get('/admin/poses', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT pose_key, label, asset_url, active, sort_order
         FROM shoutout_mascot_poses
        WHERE active = TRUE
        ORDER BY sort_order, label`
    );
    res.json({ poses: result.rows.map((p) => ({
      key: p.pose_key, label: p.label, assetUrl: p.asset_url || null, active: p.active,
    })) });
  } catch (err) { next(err); }
});

router.get('/admin/drafts', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, feature_date, recipient_name, template_version, mascot_pose_key,
              share_caption, created_by, created_at, updated_at
         FROM shoutout_drafts
        ORDER BY updated_at DESC
        LIMIT 100`
    );
    res.json({ drafts: result.rows });
  } catch (err) { next(err); }
});

router.post('/admin/drafts', requireRole('admin'), async (req, res, next) => {
  try {
    const name = cleanName(req.body.recipientName);
    const featureDate = validDateKey(req.body.featureDate);
    if (!name) return res.status(400).json({ error: 'Enter a valid recipient name.' });
    if (!featureDate) return res.status(400).json({ error: 'Choose a valid feature date.' });
    const poseKey = String(req.body.mascotPoseKey || 'power-up').trim();
    const pose = await pool.query('SELECT 1 FROM shoutout_mascot_poses WHERE pose_key = $1 AND active = TRUE', [poseKey]);
    if (!pose.rowCount) return res.status(400).json({ error: 'Choose an active mascot pose.' });
    const caption = String(req.body.shareCaption || '').trim() || null;
    const draftId = String(req.body.id || '').trim();

    let result;
    if (draftId) {
      result = await pool.query(
        `UPDATE shoutout_drafts
            SET feature_date=$2, recipient_name=$3, mascot_pose_key=$4,
                share_caption=$5, updated_at=now()
          WHERE id=$1
          RETURNING *`,
        [draftId, featureDate, name, poseKey, caption]
      );
      if (!result.rowCount) return res.status(404).json({ error: 'That draft no longer exists.' });
    } else {
      result = await pool.query(
        `INSERT INTO shoutout_drafts
           (feature_date, recipient_name, mascot_pose_key, share_caption, created_by)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING *`,
        [featureDate, name, poseKey, caption, req.user.id]
      );
    }
    res.status(draftId ? 200 : 201).json({ draft: result.rows[0], message: 'Draft saved.' });
  } catch (err) { next(err); }
});

router.delete('/admin/drafts/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query('DELETE FROM shoutout_drafts WHERE id=$1 RETURNING id', [req.params.id]);
    if (!result.rowCount) return res.status(404).json({ error: 'That draft no longer exists.' });
    res.json({ message: 'Draft deleted.' });
  } catch (err) { next(err); }
});

router.get('/admin/calendar', requireRole('admin'), async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 90, 1), 365);
    const result = await pool.query(
      `SELECT s.shoutout_date, s.recipient_name, s.template_version, s.mascot_pose_key,
              s.share_slug, s.share_caption, s.image_portrait_url, s.image_square_url,
              s.image_og_url, s.asset_status, s.asset_error, s.assets_generated_at,
              s.published_at, s.updated_at,
              COALESCE(e.total_events,0)::int AS total_events,
              COALESCE(e.downloads,0)::int AS downloads,
              COALESCE(e.shares,0)::int AS shares
         FROM shoutout_schedule s
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS total_events,
                  COUNT(*) FILTER (WHERE event_type LIKE 'shoutout_download_%') AS downloads,
                  COUNT(*) FILTER (WHERE event_type LIKE 'shoutout_share_%' OR event_type='shoutout_copy_link') AS shares
             FROM shoutout_events se
            WHERE se.shoutout_date = s.shoutout_date
         ) e ON TRUE
        ORDER BY s.shoutout_date DESC
        LIMIT $1`,
      [limit]
    );
    res.json({ shoutouts: result.rows.map((r) => ({ ...publicPayload(r), assetStatus: r.asset_status,
      assetError: r.asset_error || null, totalEvents: r.total_events, downloads: r.downloads, shares: r.shares })) });
  } catch (err) { next(err); }
});

router.post('/admin/publish', requireRole('admin'), async (req, res, next) => {
  const name = cleanName(req.body.recipientName);
  const featureDate = validDateKey(req.body.featureDate);
  if (!name) return res.status(400).json({ error: 'Enter a valid recipient name.' });
  if (!featureDate) return res.status(400).json({ error: 'Choose a valid feature date.' });
  const poseKey = String(req.body.mascotPoseKey || automaticPoseForDate(featureDate)).trim();
  const caption = String(req.body.shareCaption || '').trim() || null;
  const replace = req.body.replace === true;
  const draftId = String(req.body.draftId || '').trim() || null;

  const client = await pool.connect();
  let scheduled;
  try {
    await client.query('BEGIN');
    const pose = await client.query('SELECT 1 FROM shoutout_mascot_poses WHERE pose_key=$1 AND active=TRUE', [poseKey]);
    if (!pose.rowCount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Choose an active mascot pose.' });
    }

    const existing = await client.query(
      'SELECT * FROM shoutout_schedule WHERE shoutout_date=$1 FOR UPDATE', [featureDate]
    );
    if (existing.rowCount && !replace) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `${featureDate} already has a shout-out for ${existing.rows[0].recipient_name}.`,
        requiresReplace: true,
        existing: publicPayload(existing.rows[0]),
      });
    }

    const nomination = await client.query(
      `INSERT INTO shoutout_nominations
         (nominee_name, message, status, source, available_from)
       VALUES ($1, NULL, 'approved', 'admin', $2)
       RETURNING id`,
      [name, featureDate]
    );

    const old = existing.rows[0] || null;
    // Preserve an already-issued permalink on corrections. The record at that
    // URL is intentionally the day itself; its content can be corrected by an
    // administrator without making links posted earlier go dead.
    const slug = old && old.share_slug ? old.share_slug : shareSlug(featureDate, name);

    if (old && old.nomination_id && old.nomination_id !== nomination.rows[0].id) {
      await client.query("UPDATE shoutout_nominations SET status='rejected' WHERE id=$1", [old.nomination_id]);
    }

    const upsert = await client.query(
      `INSERT INTO shoutout_schedule
         (shoutout_date, nomination_id, fallback_name, recipient_name, template_version,
          mascot_pose_key, share_slug, share_caption, asset_status, published_at, updated_at)
       VALUES ($1,$2,NULL,$3,'v1',$4,$5,$6,'pending',NULL,now())
       ON CONFLICT (shoutout_date) DO UPDATE SET
         nomination_id=EXCLUDED.nomination_id,
         fallback_name=NULL,
         recipient_name=EXCLUDED.recipient_name,
         template_version='v1',
         mascot_pose_key=EXCLUDED.mascot_pose_key,
         share_slug=EXCLUDED.share_slug,
         share_caption=EXCLUDED.share_caption,
         image_portrait_url=NULL,
         image_square_url=NULL,
         image_og_url=NULL,
         asset_status='pending',
         asset_error=NULL,
         assets_generated_at=NULL,
         published_at=NULL,
         updated_at=now()
       RETURNING *`,
      [featureDate, nomination.rows[0].id, name, poseKey, slug, caption]
    );
    scheduled = upsert.rows[0];
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return next(err);
  } finally {
    client.release();
  }

  try {
    scheduled = await generateAndStoreAssets(scheduled);
    if (draftId) await pool.query('DELETE FROM shoutout_drafts WHERE id=$1', [draftId]).catch(() => {});
    return res.status(201).json({
      shoutout: publicPayload(scheduled),
      status: featureDate > new Date().toISOString().slice(0, 10) ? 'scheduled' : 'published',
      message: featureDate > new Date().toISOString().slice(0, 10)
        ? 'Shout-out scheduled and all three social assets are ready.'
        : 'Shout-out published and all three social assets are ready.',
    });
  } catch (err) {
    return res.status(502).json({
      error: 'The shout-out record was saved, but it was not published because one or more social images could not be generated or stored.',
      detail: err.message,
    });
  }
});

router.post('/admin/regenerate/:slug', requireRole('admin'), async (req, res, next) => {
  try {
    let row = await readSchedule('s.share_slug=$1', [String(req.params.slug || '')]);
    if (!row) return res.status(404).json({ error: 'Shout-out not found.' });
    await pool.query(
      `UPDATE shoutout_schedule
          SET asset_status='pending', asset_error=NULL,
              image_portrait_url=NULL, image_square_url=NULL, image_og_url=NULL,
              assets_generated_at=NULL, updated_at=now()
        WHERE shoutout_date=$1`, [row.shoutout_date]
    );
    row.asset_status = 'pending';
    row.image_portrait_url = row.image_square_url = row.image_og_url = null;
    row = await generateAndStoreAssets(row);
    res.json({ shoutout: publicPayload(row), message: 'All three shout-out images were regenerated.' });
  } catch (err) {
    res.status(502).json({ error: 'Could not regenerate the shout-out images.', detail: err.message });
  }
});

router.get('/admin/analytics/:slug', requireRole('admin'), async (req, res, next) => {
  try {
    const row = await readSchedule('s.share_slug=$1', [String(req.params.slug || '')]);
    if (!row) return res.status(404).json({ error: 'Shout-out not found.' });
    const events = await pool.query(
      `SELECT event_type, COUNT(*)::int AS count, MAX(created_at) AS last_event_at
         FROM shoutout_events
        WHERE shoutout_date=$1
        GROUP BY event_type
        ORDER BY count DESC, event_type`,
      [row.shoutout_date]
    );
    res.json({ shoutout: publicPayload(row), events: events.rows });
  } catch (err) { next(err); }
});

// First-party aggregate analytics. No identity/fingerprint is accepted or
// stored; only the immutable schedule date + event name are persisted.
router.post('/:slug/event', async (req, res, next) => {
  try {
    const eventType = String(req.body && req.body.eventType || '').trim();
    if (!ALLOWED_EVENTS.has(eventType)) return res.status(400).json({ error: 'Unknown shout-out event.' });
    const row = await readSchedule('s.share_slug=$1', [String(req.params.slug || '')]);
    if (!row) return res.status(404).json({ error: 'Shout-out not found.' });
    await pool.query('INSERT INTO shoutout_events (shoutout_date,event_type) VALUES ($1,$2)', [row.shoutout_date, eventType]);
    res.status(202).json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
