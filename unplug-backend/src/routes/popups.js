// Popups: the reader-facing feed, the event counter, and the admin's controls.
//
// THE PUBLIC HALF IS DELIBERATELY DUMB. GET /popups/active returns what is
// switched on and in date, and nothing else. It does not know who is asking,
// does not read a cookie and does not decide what any particular person
// should see — all of that happens in the browser, against values already on
// that device. A reader who dismissed something is not a fact this server
// needs to hold, and holding it would mean identifying them to answer a
// question their own browser can answer.
//
// WHICH MEANS THE FEED IS THE SAME FOR EVERYBODY and can be cached hard. On a
// free instance that sleeps, an endpoint every page view calls is exactly the
// endpoint that must not touch the database more than it has to.

const express = require('express');
const pool = require('../db');
const { requireRole } = require('../middleware/auth');
const { logActivity } = require('./activityLog');
const { publicSubmitLimiter } = require('../middleware/rateLimit');
const {
  cleanBlocks, cleanStyle, cleanMedia, cleanPurpose, contrastWarnings, STARTERS,
  BLOCK_TYPES, FONTS, WIDTHS, POSITIONS, ANIMATIONS, TRIGGERS, MAX_BLOCKS, pick,
} = require('../utils/popupBuilder');

const router = express.Router();

const KINDS = ['newsletter', 'announcement', 'nominate'];
const FREQUENCIES = ['session', 'days', 'once'];

// A number of seconds, or null for "no limit". Null is the meaningful answer
// for both fields that use this: no auto-close means it waits for the reader,
// and no delay means the trigger is something else entirely.
function seconds(value, max) {
  if (value === null || value === undefined || value === '') return null;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(max, n);
}

function pagesOf(value) {
  if (Array.isArray(value)) return value.filter((x) => typeof x === 'string').slice(0, 40);
  return [];
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

// GET /popups/active — everything live right now.
//
// Only the fields the browser needs to draw it. created_by, the internal name
// and the timestamps stay here: a public endpoint should not hand out the
// admin's view of a record just because the record is public.
router.get('/active', async (req, res, next) => {
  try {
    const r = await pool.query(`
      -- EVERY COLUMN QUALIFIED. popups and email_lists both have an "id" and
      -- a "name", so an unqualified list is not merely untidy — Postgres
      -- refuses the statement as ambiguous and the endpoint returns 500 for
      -- every reader.
      SELECT p.id, p.kind, p.title, p.body, p.image_url, p.button_label, p.button_url,
             p.scroll_percent, p.pages, p.frequency, p.frequency_days,
             -- The builder's fields. A popup made before the builder existed
             -- has an empty blocks list, and the renderer draws the old fixed
             -- layout from the columns above instead.
             p.blocks, p.style, p.position, p.animation,
             p.trigger_type, p.trigger_seconds, p.auto_close_seconds, p.media,
             COALESCE(l.slug, 'newsletter') AS list_slug
        FROM popups p
        LEFT JOIN email_lists l ON l.id = p.list_id
       WHERE p.active = true
         AND (p.starts_at IS NULL OR p.starts_at <= now())
         AND (p.ends_at IS NULL OR p.ends_at > now())
       ORDER BY p.id`);

    // A minute of caching. Long enough that a reader clicking through six
    // pages does not ask six times; short enough that switching a popup off
    // takes effect while somebody is still watching the screen after doing it.
    res.set('Cache-Control', 'public, max-age=60');
    res.json(r.rows);
  } catch (err) { next(err); }
});

// POST /popups/:id/event — impression, dismiss or convert.
//
// Rate limited like any other public write. It is an unauthenticated endpoint
// that inserts a row, which is the shape of thing that gets used to fill a
// database if nobody is watching.
router.post('/:id/event', publicSubmitLimiter, async (req, res) => {
  try {
    const kind = String(req.body.kind || '');
    if (!['impression', 'dismiss', 'convert'].includes(kind)) {
      return res.status(400).json({ error: 'Unknown event.' });
    }
    await pool.query(
      `INSERT INTO popup_events (popup_id, kind, session_id, page)
       SELECT $1, $2, $3, $4 WHERE EXISTS (SELECT 1 FROM popups WHERE id = $1)`,
      [req.params.id, kind,
        String(req.body.sessionId || '').slice(0, 100) || null,
        String(req.body.page || '').slice(0, 60) || null]);
    res.json({ ok: true });
  } catch (err) {
    // Never an error to the reader. A counter failing is not something the
    // person reading an article should be told about, and a popup that shows
    // an error because its analytics broke is worse than one nobody counted.
    console.error('[popups] event failed:', err.message);
    res.json({ ok: true });
  }
});

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

// GET /popups/options — the pieces the builder is allowed to use.
//
// Served rather than typed into the admin page, for the same reason the image
// sizes are: two lists of block types in two files drift, and the one that
// matters is the one the server will actually accept on save.
router.get('/options', requireRole('admin'), async (req, res, next) => {
  // The purposes already in use, so the admin can pick one they have used
  // before instead of retyping a variant of it. This is the whole mitigation
  // for free text: "Competition", "competition" and "Comp" become three
  // different things only if nobody is shown what already exists.
  let purposes = [];
  try {
    const r = await pool.query(
      `SELECT DISTINCT purpose FROM popups
        WHERE purpose IS NOT NULL AND purpose <> '' ORDER BY purpose`);
    purposes = r.rows.map((x) => x.purpose);
  } catch (err) { return next(err); }

  res.json({
    starters: STARTERS,
    purposes,
    blockTypes: BLOCK_TYPES,
    fonts: FONTS,
    widths: WIDTHS,
    positions: POSITIONS,
    animations: ANIMATIONS,
    triggers: TRIGGERS,
    maxBlocks: MAX_BLOCKS,
    embedHosts: ['YouTube', 'Vimeo', 'SoundCloud', 'Spotify'],
  });
});

// POST /popups/preview — what would be stored, and whether it can be read.
//
// The builder posts here as the admin types. It saves nothing: it runs the
// same cleaning the save would and hands back the result, so an admin sees a
// block being dropped, or a colour pair failing contrast, while they are still
// looking at the thing rather than after it is live in front of readers.
router.post('/preview', requireRole('admin'), (req, res) => {
  const blocks = cleanBlocks(req.body && req.body.blocks);
  const style = cleanStyle(req.body && req.body.style);
  const sent = Array.isArray(req.body && req.body.blocks) ? req.body.blocks.length : 0;
  res.json({
    blocks,
    style,
    contrast: contrastWarnings(style),
    // Saying HOW MANY were dropped is the part that makes this useful: a
    // silently shorter list looks like the editor lost the work.
    dropped: Math.max(0, sent - blocks.length),
  });
});

router.get('/', requireRole('admin'), async (req, res, next) => {
  try {
    const r = await pool.query(`
      SELECT p.*, l.name AS list_name,
             count(*) FILTER (WHERE e.kind = 'impression')::int AS impressions,
             count(*) FILTER (WHERE e.kind = 'dismiss')::int    AS dismissals,
             count(*) FILTER (WHERE e.kind = 'convert')::int    AS conversions
        FROM popups p
        LEFT JOIN email_lists l ON l.id = p.list_id
        LEFT JOIN popup_events e ON e.popup_id = p.id
       GROUP BY p.id, l.name
       ORDER BY p.active DESC, p.created_at DESC`);
    res.json(r.rows);
  } catch (err) { next(err); }
});

router.post('/', requireRole('admin'), async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    const title = String(req.body.title || '').trim();
    if (!name || !title) return res.status(400).json({ error: 'A popup needs a name and a title.' });
    const kind = KINDS.includes(req.body.kind) ? req.body.kind : 'newsletter';
    const blocks = cleanBlocks(req.body.blocks);
    const style = cleanStyle(req.body.style);
    const media = cleanMedia(req.body.media);
    const purpose = cleanPurpose(req.body.purpose);

    const r = await pool.query(
      `INSERT INTO popups (name, kind, title, body, image_url, button_label, button_url,
                           list_id, scroll_percent, pages, frequency, frequency_days, created_by,
                           blocks, style, position, animation,
                           trigger_type, trigger_seconds, auto_close_seconds, media, purpose)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
       RETURNING *`,
      [name.slice(0, 160), kind, title.slice(0, 200), req.body.body || null,
        req.body.imageUrl || null, req.body.buttonLabel || null, req.body.buttonUrl || null,
        req.body.listId || null,
        Math.min(100, Math.max(5, Number(req.body.scrollPercent) || 50)),
        JSON.stringify(pagesOf(req.body.pages)),
        FREQUENCIES.includes(req.body.frequency) ? req.body.frequency : 'days',
        Math.min(365, Math.max(1, Number(req.body.frequencyDays) || 30)),
        req.user.id,
        JSON.stringify(blocks), JSON.stringify(style),
        pick(POSITIONS, req.body.position, 'center'),
        pick(ANIMATIONS, req.body.animation, 'fade-up'),
        pick(TRIGGERS, req.body.triggerType, 'scroll'),
        seconds(req.body.triggerSeconds, 120),
        seconds(req.body.autoCloseSeconds, 300),
        JSON.stringify(media), purpose]);

    await logActivity(req.user.id, 'popup_created', `Created the popup "${name}"`);
    res.status(201).json(r.rows[0]);
  } catch (err) { next(err); }
});

router.patch('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const fields = [];
    const values = [];
    const set = (column, value) => { values.push(value); fields.push(`${column} = $${values.length}`); };

    if (req.body.name !== undefined) set('name', String(req.body.name).slice(0, 160));
    if (req.body.title !== undefined) set('title', String(req.body.title).slice(0, 200));
    if (req.body.body !== undefined) set('body', req.body.body || null);
    if (req.body.imageUrl !== undefined) set('image_url', req.body.imageUrl || null);
    if (req.body.buttonLabel !== undefined) set('button_label', req.body.buttonLabel || null);
    if (req.body.buttonUrl !== undefined) set('button_url', req.body.buttonUrl || null);
    if (req.body.listId !== undefined) set('list_id', req.body.listId || null);
    if (req.body.kind !== undefined && KINDS.includes(req.body.kind)) set('kind', req.body.kind);
    if (req.body.scrollPercent !== undefined) {
      set('scroll_percent', Math.min(100, Math.max(5, Number(req.body.scrollPercent) || 50)));
    }
    if (req.body.pages !== undefined) set('pages', JSON.stringify(pagesOf(req.body.pages)));
    if (req.body.frequency !== undefined && FREQUENCIES.includes(req.body.frequency)) {
      set('frequency', req.body.frequency);
    }
    if (req.body.frequencyDays !== undefined) {
      set('frequency_days', Math.min(365, Math.max(1, Number(req.body.frequencyDays) || 30)));
    }
    if (req.body.startsAt !== undefined) set('starts_at', req.body.startsAt || null);
    if (req.body.endsAt !== undefined) set('ends_at', req.body.endsAt || null);
    if (req.body.active !== undefined) set('active', !!req.body.active);

    // The builder's fields. Each is cleaned by the same whitelist the create
    // path uses — an edit is not a way in past the rules a create is held to.
    if (req.body.blocks !== undefined) set('blocks', JSON.stringify(cleanBlocks(req.body.blocks)));
    if (req.body.style !== undefined) set('style', JSON.stringify(cleanStyle(req.body.style)));
    if (req.body.media !== undefined) set('media', JSON.stringify(cleanMedia(req.body.media)));
    if (req.body.purpose !== undefined) set('purpose', cleanPurpose(req.body.purpose));
    if (req.body.position !== undefined) set('position', pick(POSITIONS, req.body.position, 'center'));
    if (req.body.animation !== undefined) set('animation', pick(ANIMATIONS, req.body.animation, 'fade-up'));
    if (req.body.triggerType !== undefined) set('trigger_type', pick(TRIGGERS, req.body.triggerType, 'scroll'));
    if (req.body.triggerSeconds !== undefined) set('trigger_seconds', seconds(req.body.triggerSeconds, 120));
    if (req.body.autoCloseSeconds !== undefined) set('auto_close_seconds', seconds(req.body.autoCloseSeconds, 300));
    if (!fields.length) return res.status(400).json({ error: 'Nothing to change.' });
    fields.push('updated_at = now()');

    values.push(req.params.id);
    const r = await pool.query(
      `UPDATE popups SET ${fields.join(', ')} WHERE id = $${values.length} RETURNING *`, values);
    if (r.rowCount === 0) return res.status(404).json({ error: 'No such popup.' });

    // Switching one on is the moment it starts interrupting readers, so it is
    // recorded as its own event rather than lost inside a generic "updated".
    if (req.body.active !== undefined) {
      await logActivity(req.user.id, req.body.active ? 'popup_activated' : 'popup_paused',
        `${req.body.active ? 'Switched on' : 'Paused'} the popup "${r.rows[0].name}"`);
    }
    res.json(r.rows[0]);
  } catch (err) { next(err); }
});

router.delete('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const r = await pool.query('DELETE FROM popups WHERE id = $1 RETURNING name', [req.params.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'No such popup.' });
    await logActivity(req.user.id, 'popup_deleted', `Deleted the popup "${r.rows[0].name}"`);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// GET /popups/:id/report — how it actually did.
router.get('/:id/report', requireRole('admin'), async (req, res, next) => {
  try {
    const p = await pool.query('SELECT * FROM popups WHERE id = $1', [req.params.id]);
    if (p.rowCount === 0) return res.status(404).json({ error: 'No such popup.' });

    const totals = await pool.query(`
      SELECT count(*) FILTER (WHERE kind = 'impression')::int AS impressions,
             count(*) FILTER (WHERE kind = 'dismiss')::int    AS dismissals,
             count(*) FILTER (WHERE kind = 'convert')::int    AS conversions
        FROM popup_events WHERE popup_id = $1`, [req.params.id]);

    const byPage = await pool.query(`
      SELECT page,
             count(*) FILTER (WHERE kind = 'impression')::int AS impressions,
             count(*) FILTER (WHERE kind = 'convert')::int    AS conversions
        FROM popup_events WHERE popup_id = $1 AND page IS NOT NULL
       GROUP BY page ORDER BY impressions DESC LIMIT 20`, [req.params.id]);

    const t = totals.rows[0];
    const rate = (n) => (t.impressions ? Math.round((n / t.impressions) * 1000) / 10 : 0);

    res.json({
      popup: p.rows[0],
      totals: t,
      rates: { conversion: rate(t.conversions), dismissal: rate(t.dismissals) },
      byPage: byPage.rows,
      // Said in the payload rather than left to be inferred from a number that
      // looks fine. A 3% conversion rate is the figure everybody quotes; the
      // one that decides whether this popup should exist is how many people it
      // interrupted to get there.
      caveat: 'Read the dismissal rate next to the conversion rate. Every conversion '
        + 'was bought by interrupting everybody else, and a popup that converts well '
        + 'while annoying most of the page is still costing more than it earns.',
    });
  } catch (err) { next(err); }
});

module.exports = router;
