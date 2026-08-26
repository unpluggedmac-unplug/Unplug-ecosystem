// The CRM: contacts, the pipeline, the timeline, tasks and the sales numbers.
//
// Admin-only throughout, reusing requireRole exactly as every other admin
// screen does. There is no separate CRM permission, for the same reason there
// is no permissions matrix anywhere else here: there is one admin role and no
// case yet where two admins should see different customers.

const express = require('express');
const pool = require('../db');
const { requireRole } = require('../middleware/auth');
const { logActivity } = require('./activityLog');
const capture = require('../utils/crmCapture');

const router = express.Router();

const STAGES = ['prospect', 'contacted', 'proposal', 'won', 'lost'];

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

// GET /crm/pipeline — everything open, grouped by stage, for the kanban.
router.get('/pipeline', requireRole('admin'), async (req, res, next) => {
  try {
    const r = await pool.query(`
      SELECT d.*, c.full_name, c.email, c.phone,
             co.name AS company_name,
             u.full_name AS owner_name,
             (SELECT max(occurred_at) FROM crm_activities a WHERE a.deal_id = d.id) AS last_activity_at
        FROM crm_deals d
        JOIN crm_contacts c ON c.id = d.contact_id
        LEFT JOIN crm_companies co ON co.id = d.company_id
        LEFT JOIN users u ON u.id = d.owner_user_id
       ORDER BY d.updated_at DESC`);

    const byStage = Object.fromEntries(STAGES.map((s) => [s, []]));
    for (const deal of r.rows) (byStage[deal.stage] || byStage.prospect).push(deal);

    res.json({
      stages: STAGES,
      deals: byStage,
      totals: Object.fromEntries(STAGES.map((s) => [s, {
        count: byStage[s].length,
        value: byStage[s].reduce((sum, d) => sum + Number(d.value || 0), 0),
      }])),
    });
  } catch (err) { next(err); }
});

// PATCH /crm/deals/:id — move a card, change a value, assign an owner.
router.patch('/deals/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'A valid deal is required.' });

    const before = await pool.query('SELECT * FROM crm_deals WHERE id = $1', [id]);
    if (before.rowCount === 0) return res.status(404).json({ error: 'That deal no longer exists.' });
    const deal = before.rows[0];

    const sets = [];
    const values = [];
    const set = (column, value) => { values.push(value); sets.push(`${column} = $${values.length}`); };

    if (req.body.stage !== undefined) {
      if (!STAGES.includes(req.body.stage)) {
        return res.status(400).json({ error: `Stage must be one of: ${STAGES.join(', ')}.` });
      }
      set('stage', req.body.stage);
      // Closing stamps the time, and reopening clears it — otherwise a deal
      // moved back out of "won" keeps a close date, and every revenue figure
      // that counts closed deals is quietly wrong.
      if (['won', 'lost'].includes(req.body.stage)) {
        if (!deal.closed_at) set('closed_at', new Date().toISOString());
      } else {
        set('closed_at', null);
      }
    }
    if (req.body.value !== undefined) {
      const value = Number(req.body.value);
      if (!Number.isFinite(value) || value < 0) {
        return res.status(400).json({ error: 'A deal value is a number, and not a negative one.' });
      }
      set('value', value);
    }
    if (req.body.probability !== undefined) {
      const p = Number(req.body.probability);
      if (!Number.isInteger(p) || p < 0 || p > 100) {
        return res.status(400).json({ error: 'Probability is a whole number between 0 and 100.' });
      }
      set('probability', p);
    }
    if (req.body.title !== undefined) set('title', String(req.body.title).slice(0, 200));
    if (req.body.ownerUserId !== undefined) set('owner_user_id', req.body.ownerUserId || null);
    if (req.body.expectedCloseOn !== undefined) set('expected_close_on', req.body.expectedCloseOn || null);
    if (req.body.lostReason !== undefined) set('lost_reason', req.body.lostReason || null);

    if (!sets.length) return res.status(400).json({ error: 'Nothing to change.' });
    values.push(id);

    const updated = await pool.query(
      `UPDATE crm_deals SET ${sets.join(', ')}, updated_at = now()
        WHERE id = $${values.length} RETURNING *`, values);

    // A stage change goes on the timeline. Six months later, "why did this
    // stall in proposal for a month" is answerable only if the moves were
    // recorded as they happened.
    if (req.body.stage && req.body.stage !== deal.stage) {
      await capture.addActivity({
        contactId: deal.contact_id, dealId: id, kind: 'system',
        subject: `Moved from ${deal.stage} to ${req.body.stage}`,
        createdBy: req.user.id,
      });
    }
    res.json({ deal: updated.rows[0] });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

// GET /crm/contacts — searchable list.
router.get('/contacts', requireRole('admin'), async (req, res, next) => {
  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const params = [];
    const where = [];

    if (req.query.q) {
      params.push(`%${String(req.query.q).slice(0, 100)}%`);
      where.push(`(c.email ILIKE $${params.length} OR c.full_name ILIKE $${params.length}
                   OR co.name ILIKE $${params.length})`);
    }
    if (req.query.status) {
      params.push(String(req.query.status));
      where.push(`c.status = $${params.length}`);
    }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const [rows, total] = await Promise.all([
      pool.query(`
        SELECT c.*, co.name AS company_name,
               (SELECT count(*)::int FROM crm_deals d WHERE d.contact_id = c.id) AS deal_count,
               (SELECT count(*)::int FROM crm_deals d
                 WHERE d.contact_id = c.id AND d.stage NOT IN ('won','lost')) AS open_deals
          FROM crm_contacts c
          LEFT JOIN crm_companies co ON co.id = c.company_id
          ${clause}
         ORDER BY c.last_seen_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, (page - 1) * limit]),
      pool.query(`SELECT count(*)::int AS n FROM crm_contacts c
                    LEFT JOIN crm_companies co ON co.id = c.company_id ${clause}`, params),
    ]);

    res.json({
      contacts: rows.rows,
      pagination: { page, limit, total: total.rows[0].n,
                    totalPages: Math.max(1, Math.ceil(total.rows[0].n / limit)) },
    });
  } catch (err) { next(err); }
});

// GET /crm/contacts/:id — one contact, with everything that has happened.
router.get('/contacts/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'A valid contact is required.' });

    const [contact, deals, activities, tasks, tags] = await Promise.all([
      pool.query(`SELECT c.*, co.name AS company_name, co.website AS company_website,
                         u.email AS account_email
                    FROM crm_contacts c
                    LEFT JOIN crm_companies co ON co.id = c.company_id
                    LEFT JOIN users u ON u.id = c.user_id
                   WHERE c.id = $1`, [id]),
      pool.query('SELECT * FROM crm_deals WHERE contact_id = $1 ORDER BY created_at DESC', [id]),
      // The timeline, newest first — the whole point of a contact record.
      pool.query(`SELECT a.*, u.full_name AS by_name
                    FROM crm_activities a
                    LEFT JOIN users u ON u.id = a.created_by
                   WHERE a.contact_id = $1
                   ORDER BY a.occurred_at DESC LIMIT 200`, [id]),
      pool.query(`SELECT t.*, u.full_name AS assignee_name
                    FROM crm_tasks t LEFT JOIN users u ON u.id = t.assignee_id
                   WHERE t.contact_id = $1 ORDER BY t.done_at NULLS FIRST, t.due_at`, [id]),
      pool.query(`SELECT tg.* FROM crm_tags tg
                    JOIN crm_contact_tags ct ON ct.tag_id = tg.id
                   WHERE ct.contact_id = $1`, [id]),
    ]);

    if (contact.rowCount === 0) return res.status(404).json({ error: 'No such contact.' });
    res.json({
      contact: contact.rows[0],
      deals: deals.rows,
      activities: activities.rows,
      tasks: tasks.rows,
      tags: tags.rows,
    });
  } catch (err) { next(err); }
});

// POST /crm/contacts/:id/activities — a note, a call, a meeting.
router.post('/contacts/:id/activities', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const kind = String(req.body.kind || 'note');
    if (!['note', 'call', 'email', 'meeting'].includes(kind)) {
      return res.status(400).json({ error: 'That is not a kind of activity somebody can log.' });
    }
    if (!req.body.body && !req.body.subject) {
      return res.status(400).json({ error: 'Say what happened.' });
    }
    const activity = await capture.addActivity({
      contactId: id, dealId: req.body.dealId || null, kind,
      subject: req.body.subject, body: req.body.body,
      createdBy: req.user.id, occurredAt: req.body.occurredAt,
    });
    res.status(201).json({ activity });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

router.get('/tasks', requireRole('admin'), async (req, res, next) => {
  try {
    const mine = String(req.query.mine) === 'true';
    const params = [];
    const where = ['t.done_at IS NULL'];
    if (mine) { params.push(req.user.id); where.push(`t.assignee_id = $${params.length}`); }
    if (String(req.query.includeDone) === 'true') where.shift();

    const r = await pool.query(`
      SELECT t.*, u.full_name AS assignee_name, c.full_name AS contact_name, c.email AS contact_email,
             (t.due_at IS NOT NULL AND t.due_at < now() AND t.done_at IS NULL) AS overdue
        FROM crm_tasks t
        LEFT JOIN users u ON u.id = t.assignee_id
        LEFT JOIN crm_contacts c ON c.id = t.contact_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY t.due_at NULLS LAST LIMIT 200`, params);
    res.json({ tasks: r.rows });
  } catch (err) { next(err); }
});

router.post('/tasks', requireRole('admin'), async (req, res, next) => {
  try {
    const title = String(req.body.title || '').trim();
    if (!title) return res.status(400).json({ error: 'A task needs a title.' });
    const r = await pool.query(
      `INSERT INTO crm_tasks (title, notes, contact_id, deal_id, assignee_id, due_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [title.slice(0, 255), req.body.notes || null, req.body.contactId || null,
       req.body.dealId || null, req.body.assigneeId || req.user.id,
       req.body.dueAt || null, req.user.id]);
    res.status(201).json({ task: r.rows[0] });
  } catch (err) { next(err); }
});

router.patch('/tasks/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (req.body.done === true) {
      const r = await pool.query(
        `UPDATE crm_tasks SET done_at = now(), done_by = $2 WHERE id = $1 AND done_at IS NULL
         RETURNING *`, [id, req.user.id]);
      if (r.rowCount === 0) return res.status(404).json({ error: 'That task is already done, or gone.' });
      return res.json({ task: r.rows[0] });
    }
    if (req.body.done === false) {
      const r = await pool.query(
        'UPDATE crm_tasks SET done_at = NULL, done_by = NULL WHERE id = $1 RETURNING *', [id]);
      return res.json({ task: r.rows[0] });
    }
    res.status(400).json({ error: 'Nothing to change.' });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// The sales dashboard
// ---------------------------------------------------------------------------

// GET /crm/dashboard — deals by stage, close rate, weighted forecast, revenue.
router.get('/dashboard', requireRole('admin'), async (req, res, next) => {
  try {
    const [byStage, closeRate, forecast, revenue, bySource] = await Promise.all([
      pool.query(`SELECT stage, count(*)::int AS n, COALESCE(sum(value), 0) AS value
                    FROM crm_deals GROUP BY stage`),

      // Of the deals that have been DECIDED, how many were won. Open deals are
      // excluded deliberately: counting them as losses makes the rate look
      // terrible early on and improve on its own as they close, which tells
      // nobody anything.
      pool.query(`SELECT count(*) FILTER (WHERE stage = 'won')::int AS won,
                         count(*) FILTER (WHERE stage = 'lost')::int AS lost
                    FROM crm_deals WHERE stage IN ('won', 'lost')`),

      // The weighted forecast: each open deal's value times its probability.
      // The unweighted total assumes everything closes, which is the number
      // that gets a magazine into trouble.
      pool.query(`SELECT COALESCE(sum(value), 0) AS raw,
                         COALESCE(sum(value * probability / 100.0), 0) AS weighted
                    FROM crm_deals WHERE stage NOT IN ('won', 'lost')`),

      pool.query(`SELECT date_trunc('month', closed_at)::date AS month,
                         COALESCE(sum(value), 0) AS value, count(*)::int AS n
                    FROM crm_deals
                   WHERE stage = 'won' AND closed_at > now() - INTERVAL '12 months'
                   GROUP BY month ORDER BY month`),

      pool.query(`SELECT source, count(*)::int AS n,
                         count(*) FILTER (WHERE stage = 'won')::int AS won,
                         COALESCE(sum(value) FILTER (WHERE stage = 'won'), 0) AS won_value
                    FROM crm_deals GROUP BY source ORDER BY n DESC`),
    ]);

    const decided = closeRate.rows[0];
    const total = decided.won + decided.lost;

    res.json({
      byStage: Object.fromEntries(byStage.rows.map((r) => [r.stage, { count: r.n, value: Number(r.value) }])),
      closeRate: {
        won: decided.won,
        lost: decided.lost,
        // null rather than 0 when nothing has been decided: "no close rate
        // yet" and "a close rate of zero" are different facts, and showing 0%
        // on a new pipeline is a lie about performance.
        percent: total > 0 ? Math.round((decided.won / total) * 100) : null,
      },
      forecast: {
        raw: Number(forecast.rows[0].raw),
        weighted: Math.round(Number(forecast.rows[0].weighted)),
        note: 'Weighted by each deal\'s probability. The raw figure assumes every '
            + 'open deal closes, which is not a forecast.',
      },
      revenueByMonth: revenue.rows.map((r) => ({ month: r.month, value: Number(r.value), deals: r.n })),
      bySource: bySource.rows.map((r) => ({
        source: r.source, deals: r.n, won: r.won, wonValue: Number(r.won_value),
      })),
    });
  } catch (err) { next(err); }
});

module.exports = router;
