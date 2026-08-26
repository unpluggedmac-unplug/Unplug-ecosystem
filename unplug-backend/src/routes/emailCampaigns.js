// The composer's back end: campaigns, lists, automations, suppressions, reports.
//
// ADMIN-ONLY THROUGHOUT, using requireRole exactly as every other admin screen
// does. The public half of the email platform — unsubscribing, the preference
// centre, the tracking endpoints — lives in routes/email.js and is deliberately
// unauthenticated. The two files are separate so that neither can be read
// wrongly: everything in email.js is public on purpose, everything here needs
// an admin, and there is no line in either file where that changes.
//
// THE SENDING IS NOT DUPLICATED HERE. Both the "send now" button and the
// scheduled tick go through utils/emailScheduler.js, which goes through
// utils/emailMarketing.js. Sending is the thing that must not have two
// implementations that drift: one of them would get the suppression check and
// the other would not, and it would be the quiet one that mails somebody who
// asked to be left alone.

const express = require('express');
const pool = require('../db');
const { requireRole } = require('../middleware/auth');
const { logActivity } = require('./activityLog');
const marketing = require('../utils/emailMarketing');
const renderer = require('../utils/emailRenderer');
const scheduler = require('../utils/emailScheduler');

const router = express.Router();

function blocksOf(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') { try { return JSON.parse(value) || []; } catch { return []; } }
  return [];
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

router.get('/lists', requireRole('admin'), async (req, res, next) => {
  try {
    const r = await pool.query(`
      SELECT l.*,
             count(*) FILTER (WHERE s.status = 'subscribed') AS subscribed,
             count(*) FILTER (WHERE s.status = 'unsubscribed') AS unsubscribed,
             -- The number that matters before pressing send: subscribed AND
             -- reachable. A list showing 400 that can only deliver to 340 is
             -- a list that makes every report look like a failure.
             count(*) FILTER (WHERE s.status = 'subscribed' AND sup.email IS NULL) AS reachable
        FROM email_lists l
        LEFT JOIN email_subscriptions s ON s.list_id = l.id
        LEFT JOIN email_suppressions sup ON sup.email = LOWER(s.email)
       GROUP BY l.id
       ORDER BY l.name`);
    res.json(r.rows);
  } catch (err) { next(err); }
});

router.post('/lists', requireRole('admin'), async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'The list needs a name.' });
    const slug = String(req.body.slug || name).toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 120);
    if (!slug) return res.status(400).json({ error: 'That name does not make a usable slug.' });

    const r = await pool.query(
      `INSERT INTO email_lists (name, slug, description, public) VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [name.slice(0, 120), slug, req.body.description || null, req.body.public !== false]);
    await logActivity(req.user.id, 'email_list_created', `Created the mailing list "${name}"`);
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A list with that slug already exists.' });
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

router.get('/campaigns', requireRole('admin'), async (req, res, next) => {
  try {
    const r = await pool.query(`
      SELECT c.*, l.name AS list_name, u.full_name AS created_by_name,
             (SELECT count(*) FROM email_sends s WHERE s.campaign_id = c.id AND s.status = 'sent') AS sent_count
        FROM email_campaigns c
        LEFT JOIN email_lists l ON l.id = c.list_id
        LEFT JOIN users u ON u.id = c.created_by
       ORDER BY c.created_at DESC
       LIMIT 200`);
    res.json(r.rows);
  } catch (err) { next(err); }
});

router.get('/campaigns/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const r = await pool.query('SELECT * FROM email_campaigns WHERE id = $1', [req.params.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'No such campaign.' });
    res.json(r.rows[0]);
  } catch (err) { next(err); }
});

router.post('/campaigns', requireRole('admin'), async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    const subject = String(req.body.subject || '').trim();
    if (!name || !subject) return res.status(400).json({ error: 'A campaign needs a name and a subject.' });

    const r = await pool.query(
      `INSERT INTO email_campaigns (name, subject, preheader, blocks, list_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [name.slice(0, 200), subject.slice(0, 255), req.body.preheader || null,
        JSON.stringify(blocksOf(req.body.blocks)), req.body.listId || null, req.user.id]);
    await logActivity(req.user.id, 'email_campaign_created', `Created the campaign "${name}"`);
    res.status(201).json(r.rows[0]);
  } catch (err) { next(err); }
});

// PATCH — the composer's autosave.
//
// A CAMPAIGN THAT IS SENDING OR SENT CANNOT BE EDITED. Editing a sent campaign
// would change what the report says was sent, and editing one mid-send would
// have the second half of the list receive a different email from the first.
router.patch('/campaigns/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const existing = await pool.query('SELECT status FROM email_campaigns WHERE id = $1', [req.params.id]);
    if (existing.rowCount === 0) return res.status(404).json({ error: 'No such campaign.' });
    if (['sending', 'sent'].includes(existing.rows[0].status)) {
      return res.status(409).json({
        error: 'That campaign has already gone out. Duplicate it if you want to send a changed version.',
      });
    }

    const fields = [];
    const values = [];
    const set = (column, value) => { values.push(value); fields.push(`${column} = $${values.length}`); };

    if (req.body.name !== undefined) set('name', String(req.body.name).slice(0, 200));
    if (req.body.subject !== undefined) set('subject', String(req.body.subject).slice(0, 255));
    if (req.body.preheader !== undefined) set('preheader', req.body.preheader || null);
    if (req.body.blocks !== undefined) set('blocks', JSON.stringify(blocksOf(req.body.blocks)));
    if (req.body.listId !== undefined) set('list_id', req.body.listId || null);
    if (!fields.length) return res.status(400).json({ error: 'Nothing to change.' });

    values.push(req.params.id);
    const r = await pool.query(
      `UPDATE email_campaigns SET ${fields.join(', ')} WHERE id = $${values.length} RETURNING *`, values);
    res.json(r.rows[0]);
  } catch (err) { next(err); }
});

router.delete('/campaigns/:id', requireRole('admin'), async (req, res, next) => {
  try {
    // A sent campaign is kept. Deleting it would take its sends and its
    // reporting with it (they cascade), and "what did we send them in March"
    // is a question somebody asks.
    const r = await pool.query(
      `DELETE FROM email_campaigns WHERE id = $1 AND status IN ('draft', 'scheduled', 'cancelled')
       RETURNING name, status`, [req.params.id]);
    if (r.rowCount === 0) {
      return res.status(409).json({ error: 'Only a draft or a scheduled campaign can be deleted.' });
    }
    await logActivity(req.user.id, 'email_campaign_deleted', `Deleted the campaign "${r.rows[0].name}"`);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Duplicate — the way to "edit" something already sent.
router.post('/campaigns/:id/duplicate', requireRole('admin'), async (req, res, next) => {
  try {
    const r = await pool.query(
      `INSERT INTO email_campaigns (name, subject, preheader, blocks, list_id, created_by)
       SELECT left(name || ' (copy)', 200), subject, preheader, blocks, list_id, $2
         FROM email_campaigns WHERE id = $1
       RETURNING *`, [req.params.id, req.user.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'No such campaign.' });
    res.status(201).json(r.rows[0]);
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

// The rendered email, plus the honest audience numbers. Returned as JSON with
// the HTML as a string rather than served as a page, so the composer can put
// it in a sandboxed iframe — the same HTML rendered at the admin's own origin
// would be a stored-XSS hole wearing a preview's clothes.
router.post('/preview', requireRole('admin'), async (req, res, next) => {
  try {
    const { html, text } = renderer.render({
      subject: req.body.subject || '',
      preheader: req.body.preheader || '',
      blocks: blocksOf(req.body.blocks),
    });

    let audience = null;
    if (req.body.listId) {
      const a = await marketing.audienceFor(req.body.listId);
      audience = {
        willSend: a.willSend.length,
        willSkip: a.willSkip.length,
        skipReasons: a.willSkip.reduce((acc, x) => {
          acc[x.suppression_reason] = (acc[x.suppression_reason] || 0) + 1;
          return acc;
        }, {}),
      };
    }
    res.json({ html, text, audience });
  } catch (err) { next(err); }
});

// A real send, to one address, so somebody can look at it in their own client.
//
// SUPPRESSION STILL APPLIES. A test send is still an email arriving at a real
// address, and "it was only a test" is not a thing the person receiving it
// agreed to. It goes through sendOne like everything else.
router.post('/campaigns/:id/test', requireRole('admin'), async (req, res, next) => {
  try {
    const to = marketing.normalise(req.body.email);
    if (!to.includes('@')) return res.status(400).json({ error: 'An email address is required.' });

    const c = await pool.query('SELECT * FROM email_campaigns WHERE id = $1', [req.params.id]);
    if (c.rowCount === 0) return res.status(404).json({ error: 'No such campaign.' });
    const campaign = c.rows[0];

    const { html, text } = renderer.render({
      subject: campaign.subject, preheader: campaign.preheader, blocks: campaign.blocks,
    });

    const result = await marketing.sendOne({
      // NOT attached to the campaign. A test send counted in the campaign's
      // report would put the admin's own open and click in the numbers, and
      // a campaign tested six times would report six sends before it went out.
      campaignId: null,
      email: to,
      subject: `[test] ${campaign.subject}`,
      html,
      text,
    });

    if (result.status === 'skipped') {
      return res.status(409).json({
        error: `${to} is on the suppression list (${result.skip_reason}), so nothing was sent.`,
      });
    }
    if (result.status === 'failed') return res.status(502).json({ error: result.error });
    res.json({ ok: true, sentTo: to });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

// Schedule, or send now — which is scheduling for a moment already past.
//
// ONE PATH, deliberately. "Send now" that bypassed the scheduler would be a
// second implementation of sending, and the two would drift. Instead this sets
// scheduled_for and then runs one tick immediately, so the button is
// responsive and the code is the same code.
router.post('/campaigns/:id/send', requireRole('admin'), async (req, res, next) => {
  try {
    const c = await pool.query('SELECT * FROM email_campaigns WHERE id = $1', [req.params.id]);
    if (c.rowCount === 0) return res.status(404).json({ error: 'No such campaign.' });
    const campaign = c.rows[0];

    if (campaign.status !== 'draft' && campaign.status !== 'scheduled') {
      return res.status(409).json({ error: `That campaign is already ${campaign.status}.` });
    }
    if (!campaign.list_id) return res.status(400).json({ error: 'Choose a list before sending.' });
    if (!blocksOf(campaign.blocks).length) {
      return res.status(400).json({ error: 'The campaign is empty. Add something to it first.' });
    }

    let when = null;
    if (req.body.scheduledFor) {
      when = new Date(req.body.scheduledFor);
      if (Number.isNaN(when.getTime())) return res.status(400).json({ error: 'That is not a valid date and time.' });
      // A schedule in the past would send immediately, which is not what
      // somebody who typed a date meant — usually they got the timezone or
      // the year wrong, and finding out by having it go out is expensive.
      if (when.getTime() < Date.now() - 60 * 1000) {
        return res.status(400).json({ error: 'That time has already passed. Use "send now" if you meant now.' });
      }
    }

    const audience = await marketing.audienceFor(campaign.list_id);
    if (!audience.willSend.length) {
      return res.status(400).json({ error: 'Nobody on that list can be sent to right now.' });
    }

    await pool.query(
      `UPDATE email_campaigns SET status = 'scheduled', scheduled_for = $2 WHERE id = $1`,
      [campaign.id, when || new Date()]);

    await logActivity(req.user.id, 'email_campaign_scheduled',
      when
        ? `Scheduled "${campaign.name}" for ${when.toISOString()} — ${audience.willSend.length} recipient(s)`
        : `Sent "${campaign.name}" to ${audience.willSend.length} recipient(s)`);

    if (when) {
      return res.json({ ok: true, scheduled: true, scheduledFor: when, recipients: audience.willSend.length });
    }

    // Sending now. The response is not held open for the whole send — four
    // hundred messages take minutes and the browser would time out — so the
    // tick is started and the admin screen polls the report.
    scheduler.tick().catch((err) => console.error('[email] immediate send failed:', err.message));
    res.json({ ok: true, sending: true, recipients: audience.willSend.length });
  } catch (err) { next(err); }
});

// Unschedule. Only works while it is still scheduled — once the tick has
// claimed it, it is going out, and saying otherwise would be a lie.
router.post('/campaigns/:id/cancel', requireRole('admin'), async (req, res, next) => {
  try {
    const r = await pool.query(
      `UPDATE email_campaigns SET status = 'draft', scheduled_for = NULL
        WHERE id = $1 AND status = 'scheduled' RETURNING name`, [req.params.id]);
    if (r.rowCount === 0) {
      return res.status(409).json({
        error: 'That campaign is not waiting to go out — it is either already sending or already sent.',
      });
    }
    await logActivity(req.user.id, 'email_campaign_cancelled', `Cancelled the scheduled campaign "${r.rows[0].name}"`);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

router.get('/campaigns/:id/report', requireRole('admin'), async (req, res, next) => {
  try {
    const c = await pool.query('SELECT * FROM email_campaigns WHERE id = $1', [req.params.id]);
    if (c.rowCount === 0) return res.status(404).json({ error: 'No such campaign.' });

    const sends = await pool.query(`
      SELECT count(*) FILTER (WHERE status = 'sent')::int    AS sent,
             count(*) FILTER (WHERE status = 'failed')::int  AS failed,
             count(*) FILTER (WHERE status = 'skipped')::int AS skipped,
             count(*)::int AS total
        FROM email_sends WHERE campaign_id = $1`, [req.params.id]);

    // COUNTED PER PERSON, not per event. A mail client that refetches the
    // pixel forty times is one reader, and counting the fetches would turn a
    // 12% open rate into 300%.
    const events = await pool.query(`
      SELECT count(DISTINCT s.id) FILTER (WHERE e.kind = 'open')::int        AS opened,
             count(DISTINCT s.id) FILTER (WHERE e.kind = 'click')::int       AS clicked,
             count(DISTINCT s.id) FILTER (WHERE e.kind = 'unsubscribe')::int AS unsubscribed,
             count(DISTINCT s.id) FILTER (WHERE e.kind = 'bounce')::int      AS bounced,
             count(DISTINCT s.id) FILTER (WHERE e.kind = 'complaint')::int   AS complained
        FROM email_sends s
        JOIN email_events e ON e.send_id = s.id
       WHERE s.campaign_id = $1`, [req.params.id]);

    const links = await pool.query(`
      SELECT e.url, count(DISTINCT s.id)::int AS clicks
        FROM email_sends s JOIN email_events e ON e.send_id = s.id
       WHERE s.campaign_id = $1 AND e.kind = 'click' AND e.url IS NOT NULL
       GROUP BY e.url ORDER BY clicks DESC LIMIT 20`, [req.params.id]);

    const failures = await pool.query(`
      SELECT email, status, skip_reason, error FROM email_sends
       WHERE campaign_id = $1 AND status IN ('failed', 'skipped')
       ORDER BY id LIMIT 100`, [req.params.id]);

    const stats = { ...sends.rows[0], ...(events.rows[0] || {}) };
    const rate = (n) => (stats.sent ? Math.round((n / stats.sent) * 1000) / 10 : 0);

    res.json({
      campaign: c.rows[0],
      stats,
      rates: {
        open: rate(stats.opened || 0),
        click: rate(stats.clicked || 0),
        unsubscribe: rate(stats.unsubscribed || 0),
      },
      links: links.rows,
      failures: failures.rows,
      // Said out loud in the payload rather than left for somebody to work out
      // from a number that looks disappointing. Apple Mail Privacy Protection
      // fetches every pixel whether or not the message was read, and most
      // other clients block images by default — so the open rate is a floor
      // with noise on top, and the click rate is the number to trust.
      caveat: 'Opens are approximate. Image blocking hides real opens and Apple '
        + 'Mail Privacy Protection invents ones that did not happen. Clicks are '
        + 'measured directly and are the number worth acting on.',
    });
  } catch (err) { next(err); }
});

// The overview across everything, for the dashboard tab.
router.get('/overview', requireRole('admin'), async (req, res, next) => {
  try {
    const totals = await pool.query(`
      SELECT count(*) FILTER (WHERE status = 'sent')::int AS sent_30d,
             count(*) FILTER (WHERE status = 'failed')::int AS failed_30d,
             count(*) FILTER (WHERE status = 'skipped')::int AS skipped_30d
        FROM email_sends WHERE created_at > now() - interval '30 days'`);

    const suppressions = await pool.query(
      `SELECT reason, count(*)::int AS n FROM email_suppressions GROUP BY reason ORDER BY n DESC`);

    const upcoming = await pool.query(`
      SELECT id, name, subject, scheduled_for FROM email_campaigns
       WHERE status = 'scheduled' ORDER BY scheduled_for LIMIT 10`);

    const automations = await pool.query(`
      SELECT a.id, a.name, a.active,
             count(*) FILTER (WHERE e.status = 'active')::int AS active_enrolments
        FROM email_automations a
        LEFT JOIN email_automation_enrolments e ON e.automation_id = a.id
       GROUP BY a.id ORDER BY a.name`);

    res.json({
      last30Days: totals.rows[0],
      suppressions: suppressions.rows,
      upcoming: upcoming.rows,
      automations: automations.rows,
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Suppressions
// ---------------------------------------------------------------------------

router.get('/suppressions', requireRole('admin'), async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase();
    const r = await pool.query(
      `SELECT * FROM email_suppressions
        WHERE ($1 = '' OR email LIKE '%' || $1 || '%')
        ORDER BY created_at DESC LIMIT 500`, [q]);
    res.json(r.rows);
  } catch (err) { next(err); }
});

router.post('/suppressions', requireRole('admin'), async (req, res, next) => {
  try {
    const email = marketing.normalise(req.body.email);
    if (!email.includes('@')) return res.status(400).json({ error: 'An email address is required.' });
    await marketing.suppress(email, 'manual', String(req.body.detail || 'added by an admin').slice(0, 200));
    await marketing.cancelEnrolments(email, 'manual');
    await logActivity(req.user.id, 'email_suppressed', `Suppressed ${email}`);
    res.status(201).json({ ok: true });
  } catch (err) { next(err); }
});

// Removing a suppression is a real decision, so it is logged loudly.
//
// AN UNSUBSCRIBE IS NOT UNDONE HERE. Taking somebody off the suppression list
// because they asked to come back is legitimate; doing it because a campaign's
// numbers looked low is mailing people who said no. The log records which
// address and who did it, and the reason is required.
router.delete('/suppressions/:email', requireRole('admin'), async (req, res, next) => {
  try {
    const email = marketing.normalise(req.params.email);
    const reason = String(req.body && req.body.reason || '').trim();
    if (!reason) {
      return res.status(400).json({ error: 'Say why this address is being made mailable again.' });
    }
    const r = await pool.query('DELETE FROM email_suppressions WHERE email = $1 RETURNING reason', [email]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'That address is not suppressed.' });
    await logActivity(req.user.id, 'email_suppression_removed',
      `Removed ${email} from the suppression list (was: ${r.rows[0].reason}) — ${reason}`);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Automations
// ---------------------------------------------------------------------------

router.get('/automations', requireRole('admin'), async (req, res, next) => {
  try {
    const r = await pool.query(`
      SELECT a.*, l.name AS trigger_list_name,
             (SELECT count(*)::int FROM email_automation_steps s WHERE s.automation_id = a.id) AS steps,
             count(*) FILTER (WHERE e.status = 'active')::int    AS active_enrolments,
             count(*) FILTER (WHERE e.status = 'completed')::int AS completed_enrolments,
             count(*) FILTER (WHERE e.status = 'cancelled')::int AS cancelled_enrolments
        FROM email_automations a
        LEFT JOIN email_lists l ON l.id = a.trigger_list_id
        LEFT JOIN email_automation_enrolments e ON e.automation_id = a.id
       GROUP BY a.id, l.name
       ORDER BY a.created_at DESC`);
    res.json(r.rows);
  } catch (err) { next(err); }
});

router.get('/automations/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const a = await pool.query('SELECT * FROM email_automations WHERE id = $1', [req.params.id]);
    if (a.rowCount === 0) return res.status(404).json({ error: 'No such automation.' });
    const steps = await pool.query(
      'SELECT * FROM email_automation_steps WHERE automation_id = $1 ORDER BY position', [req.params.id]);
    res.json({ ...a.rows[0], steps: steps.rows });
  } catch (err) { next(err); }
});

router.post('/automations', requireRole('admin'), async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'The automation needs a name.' });
    const trigger = ['subscribe', 'signup', 'purchase', 'manual'].includes(req.body.trigger)
      ? req.body.trigger : 'subscribe';

    const r = await pool.query(
      `INSERT INTO email_automations (name, description, trigger, trigger_list_id, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name.slice(0, 200), req.body.description || null, trigger,
        req.body.triggerListId || null, req.user.id]);
    await logActivity(req.user.id, 'email_automation_created', `Created the automation "${name}"`);
    res.status(201).json(r.rows[0]);
  } catch (err) { next(err); }
});

// Switching one on is the moment it starts mailing people by itself, so it is
// checked and it is logged.
router.patch('/automations/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const current = await pool.query('SELECT * FROM email_automations WHERE id = $1', [req.params.id]);
    if (current.rowCount === 0) return res.status(404).json({ error: 'No such automation.' });

    if (req.body.active === true) {
      const steps = await pool.query(
        'SELECT count(*)::int AS n FROM email_automation_steps WHERE automation_id = $1', [req.params.id]);
      if (steps.rows[0].n === 0) {
        return res.status(400).json({ error: 'Add at least one email before switching this on.' });
      }
      if (current.rows[0].trigger === 'subscribe' && !current.rows[0].trigger_list_id
          && !req.body.triggerListId) {
        return res.status(400).json({ error: 'Choose the list that starts this sequence.' });
      }
    }

    const fields = [];
    const values = [];
    const set = (column, value) => { values.push(value); fields.push(`${column} = $${values.length}`); };
    if (req.body.name !== undefined) set('name', String(req.body.name).slice(0, 200));
    if (req.body.description !== undefined) set('description', req.body.description || null);
    if (req.body.triggerListId !== undefined) set('trigger_list_id', req.body.triggerListId || null);
    if (req.body.active !== undefined) set('active', !!req.body.active);
    if (!fields.length) return res.status(400).json({ error: 'Nothing to change.' });
    fields.push('updated_at = now()');

    values.push(req.params.id);
    const r = await pool.query(
      `UPDATE email_automations SET ${fields.join(', ')} WHERE id = $${values.length} RETURNING *`, values);

    if (req.body.active !== undefined && req.body.active !== current.rows[0].active) {
      await logActivity(req.user.id, req.body.active ? 'email_automation_activated' : 'email_automation_paused',
        `${req.body.active ? 'Switched on' : 'Paused'} the automation "${r.rows[0].name}"`);
    }
    res.json(r.rows[0]);
  } catch (err) { next(err); }
});

// Steps are APPENDED at the next free position and never renumbered — people
// part-way through a sequence record the position they have reached, and
// shifting positions underneath them would move them backwards or skip them.
router.post('/automations/:id/steps', requireRole('admin'), async (req, res, next) => {
  try {
    const subject = String(req.body.subject || '').trim();
    if (!subject) return res.status(400).json({ error: 'The email needs a subject.' });

    const r = await pool.query(
      `INSERT INTO email_automation_steps (automation_id, position, delay_hours, subject, preheader, blocks)
       VALUES ($1,
               COALESCE((SELECT max(position) FROM email_automation_steps WHERE automation_id = $1), 0) + 1,
               $2, $3, $4, $5)
       RETURNING *`,
      [req.params.id, Math.max(0, Number(req.body.delayHours) || 0), subject.slice(0, 255),
        req.body.preheader || null, JSON.stringify(blocksOf(req.body.blocks))]);
    res.status(201).json(r.rows[0]);
  } catch (err) { next(err); }
});

router.patch('/automations/:id/steps/:stepId', requireRole('admin'), async (req, res, next) => {
  try {
    const fields = [];
    const values = [];
    const set = (column, value) => { values.push(value); fields.push(`${column} = $${values.length}`); };
    if (req.body.subject !== undefined) set('subject', String(req.body.subject).slice(0, 255));
    if (req.body.preheader !== undefined) set('preheader', req.body.preheader || null);
    if (req.body.blocks !== undefined) set('blocks', JSON.stringify(blocksOf(req.body.blocks)));
    if (req.body.delayHours !== undefined) set('delay_hours', Math.max(0, Number(req.body.delayHours) || 0));
    if (!fields.length) return res.status(400).json({ error: 'Nothing to change.' });

    values.push(req.params.stepId, req.params.id);
    const r = await pool.query(
      `UPDATE email_automation_steps SET ${fields.join(', ')}
        WHERE id = $${values.length - 1} AND automation_id = $${values.length} RETURNING *`, values);
    if (r.rowCount === 0) return res.status(404).json({ error: 'No such step.' });
    res.json(r.rows[0]);
  } catch (err) { next(err); }
});

router.delete('/automations/:id/steps/:stepId', requireRole('admin'), async (req, res, next) => {
  try {
    const r = await pool.query(
      'DELETE FROM email_automation_steps WHERE id = $1 AND automation_id = $2 RETURNING position',
      [req.params.stepId, req.params.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'No such step.' });
    // The gap is left on purpose. Renumbering would move everybody currently
    // part-way through the sequence — somebody on step 3 would suddenly be on
    // what used to be step 4 and would never receive it.
    res.json({ ok: true, note: 'The remaining steps keep their positions.' });
  } catch (err) { next(err); }
});

router.get('/automations/:id/enrolments', requireRole('admin'), async (req, res, next) => {
  try {
    const r = await pool.query(`
      SELECT id, email, last_position, next_run_at, status, stopped_reason, created_at
        FROM email_automation_enrolments
       WHERE automation_id = $1
       ORDER BY created_at DESC LIMIT 300`, [req.params.id]);
    res.json(r.rows);
  } catch (err) { next(err); }
});

// Enrolling by hand — for a 'manual' automation, or to put one person through
// a sequence deliberately.
router.post('/automations/:id/enrol', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await marketing.enrol({
      automationId: Number(req.params.id),
      email: req.body.email,
      delayHours: req.body.delayHours,
    });
    if (!result.ok) return res.status(409).json({ error: result.reason });
    await logActivity(req.user.id, 'email_automation_enrolled',
      `Enrolled ${marketing.normalise(req.body.email)} in automation ${req.params.id}`);
    res.status(201).json(result);
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// The tick, for an external scheduler
// ---------------------------------------------------------------------------

// The in-process interval only fires while the instance is awake, and Render's
// free tier sleeps. This is the same shape as POST /maintenance/cleanup and
// POST /backups/run: a shared secret rather than an admin session, because the
// caller is a cron service and has no way to log in.
router.post('/tick', async (req, res, next) => {
  try {
    const secret = process.env.UNPLUG_CLEANUP_SECRET;
    const isAdmin = req.user && req.user.role === 'admin';
    if (!isAdmin) {
      if (!secret) return res.status(503).json({ error: 'No scheduler secret is configured.' });
      if (req.get('X-Cron-Secret') !== secret) return res.status(401).json({ error: 'Not authorised.' });
    }
    res.json(await scheduler.tick());
  } catch (err) { next(err); }
});

module.exports = router;
