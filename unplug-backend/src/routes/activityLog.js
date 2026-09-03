// The audit trail: what admins did, when, and from where.
//
// Written to from seventy-eight places across the routes. The signature of
// logActivity is unchanged, deliberately — the address is picked up from the
// request context rather than passed in, so every existing call site records
// it without being edited and none can be missed.
//
// READ AS ONE SCREEN, SEARCHED THREE WAYS. When something has gone wrong the
// questions are always the same: what did this admin do, what happened to this
// account, and what came from this address. Those are the filters.

const express = require('express');
const pool = require('../db');
const { requireRole } = require('../middleware/auth');
const requestContext = require('../middleware/requestContext');

const router = express.Router();

// Actions worth being told about at the time rather than discovered later.
//
// The test of membership is not "is this important" — approving an article is
// important — but "would I want to know within the minute if it happened and
// it was not me". Everything here either removes a safeguard, moves money, or
// changes who can do what.
const HIGH_RISK_ACTIONS = new Set([
  'user_deleted', 'user_role_changed', 'user_suspended', 'user_unsuspended',
  'payment_refunded', 'payment_deleted', 'order_refunded',
  'login_delay_cleared', 'ip_block_removed',
  'redirect_created', 'redirect_deleted',
  'database_cleanup',
  'admin_created', 'password_reset_forced',
]);

function isHighRisk(action) {
  return HIGH_RISK_ACTIONS.has(action);
}

// Records one action.
//
// Signature unchanged from before this file grew: (adminUserId, action,
// details). The fourth argument is for callers outside a request — a scheduled
// job — that want to say so explicitly rather than have the context read back
// empty.
async function logActivity(adminUserId, action, details, override, actorRole = 'admin') {
  try {
    const ctx = override || requestContext.current();
    await pool.query(
      `INSERT INTO admin_activity_log
         (admin_user_id, action, details, ip_address, user_agent, high_risk, actor_role)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [adminUserId, action, details || null,
       ctx.ip || null, ctx.userAgent || null, isHighRisk(action), actorRole]
    );
  } catch (err) {
    // Never throws. An audit entry failing must not be the reason the action
    // it describes fails — the alternative is that a database hiccup stops an
    // admin approving an article.
    console.error('[activity log] failed to record:', err.message);
  }

  if (isHighRisk(action)) alertOnHighRisk(adminUserId, action, details, override);
}

// The member's own action, recorded in the same place as staff decisions.
//
// A separate function rather than a fifth argument at every call site: the 117
// existing calls are all admin actions and should keep saying so by default,
// and a submission route reading `logSubmission(...)` says what it is.
//
// Same guarantees as logActivity: never throws, and a failed audit entry never
// stops the thing it describes.
async function logSubmission(userId, action, details) {
  return logActivity(userId, action, details, undefined, 'member');
}

// Tells somebody, now, when a safeguard was removed or money moved.
//
// OFF UNLESS AN ADDRESS IS CONFIGURED. An alerting system that emails the
// wrong person, or emails nobody because it was never set up, is worse than
// none: it produces the belief that somebody is watching.
//
// NOT AWAITED, and failures are swallowed. The action has already happened and
// is already recorded; a slow mail provider must never become a slow admin
// screen, and a bounced alert must never undo an approval.
function alertOnHighRisk(adminUserId, action, details, override) {
  const to = process.env.UNPLUG_SECURITY_ALERT_EMAIL;
  if (!to) return;

  const ctx = override || requestContext.current();
  const lines = [
    `A high-risk action was recorded on Unplug.`,
    ``,
    `Action:  ${action}`,
    `Details: ${details || '(none)'}`,
    `Admin:   user #${adminUserId}`,
    `From:    ${ctx.ip || 'unknown address'}`,
    `When:    ${new Date().toISOString()}`,
    ``,
    `If this was you, nothing is wrong and no reply is needed.`,
    `If it was not, change your password and review the activity log.`,
  ];

  // Required lazily. utils/email reads its provider configuration at load, and
  // pulling it in at the top of this file would make every test that touches
  // the audit log initialise a mail provider it has no use for.
  Promise.resolve()
    .then(() => require('../utils/email').sendEmail({
      to,
      subject: `[Unplug security] ${action}`,
      // fromCharCode(10) is a newline. Written this way because the escape
      // sequence keeps getting mangled by the tooling that edits this file.
      text: lines.join(String.fromCharCode(10)),
    }))
    .catch((e) => console.error('[activity log] high-risk alert not sent:', e.message));
}

// Builds the WHERE clause from whatever filters were supplied.
//
// Every value is a parameter, never interpolated. This endpoint takes free
// text from a search box and puts it in a query, which is exactly the shape of
// an injection if it is done carelessly.
function buildFilters(query) {
  const where = [];
  const params = [];

  // Pushes a value and returns its placeholder, so the numbering can never
  // drift from the array. An earlier version patched placeholders after the
  // fact and was one edit away from pointing a condition at the wrong value.
  const p = (value) => { params.push(value); return `$${params.length}`; };

  // EVERY COLUMN IS QUALIFIED WITH l. The listing joins users, and users has
  // a created_at of its own — an unqualified date filter is ambiguous there
  // and Postgres refuses the query outright. Both statements below alias this
  // table as l so one clause can serve them.
  if (query.q) {
    // Matches an action name or anything in the details: a person's name, an
    // id, part of an email. One placeholder used twice, deliberately.
    const term = p(`%${String(query.q).slice(0, 100)}%`);
    where.push(`(l.action ILIKE ${term} OR l.details ILIKE ${term})`);
  }
  if (query.action) where.push(`l.action = ${p(String(query.action).slice(0, 60))}`);
  if (query.adminUserId && /^\d+$/.test(String(query.adminUserId))) {
    where.push(`l.admin_user_id = ${p(Number(query.adminUserId))}`);
  }
  if (query.ip) where.push(`l.ip_address = ${p(String(query.ip).slice(0, 64))}`);
  // Dates are passed straight to Postgres as parameters and cast there. An
  // unparseable date raises rather than silently matching everything, which is
  // the failure that would quietly show an admin the wrong window.
  if (query.from) where.push(`l.created_at >= ${p(String(query.from))}::timestamptz`);
  if (query.to) where.push(`l.created_at <= ${p(String(query.to))}::timestamptz`);
  if (String(query.highRiskOnly) === 'true') where.push('l.high_risk');

  return { clause: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

// GET /admin/activity-log — searchable, filterable, paginated.
//
// Every admin sees everything. There is exactly one admin role in this system
// and no case yet where two admins should see different entries; inventing a
// visibility rule to express a distinction nobody has made would be a lookup
// on every read and a second thing to get wrong.
router.get('/', requireRole('admin'), async (req, res, next) => {
  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const offset = (page - 1) * limit;

    const { clause, params } = buildFilters(req.query);

    const [rows, total] = await Promise.all([
      pool.query(
        `SELECT l.id, l.admin_user_id, l.action, l.details, l.created_at,
                l.ip_address, l.user_agent, l.high_risk,
                -- Joined so the screen can say who, by name. It showed a dash
                -- in the "By" column before this, because the query returned
                -- an id and the page was reading an email that was never sent.
                u.email AS admin_email, u.full_name AS admin_name
           FROM admin_activity_log l
           LEFT JOIN users u ON u.id = l.admin_user_id
           ${clause}
          ORDER BY l.created_at DESC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
      pool.query(`SELECT count(*)::int AS n FROM admin_activity_log l ${clause}`, params),
    ]);

    res.json({
      activity: rows.rows,
      pagination: {
        page, limit, total: total.rows[0].n,
        totalPages: Math.max(1, Math.ceil(total.rows[0].n / limit)),
      },
    });
  } catch (err) {
    // The raw error goes to the server log, not the response — database
    // messages can name tables and columns, which is detail an attacker
    // shouldn't get for free.
    console.error('[activity log] query failed:', err);
    res.status(500).json({ error: 'Could not load activity log.' });
  }
});

// GET /admin/activity-log/actions — the distinct action names, for the filter
// dropdown. Read from the data rather than a hard-coded list, so a new kind of
// entry appears in the filter the first time it happens.
router.get('/actions', requireRole('admin'), async (req, res, next) => {
  try {
    const r = await pool.query(
      `SELECT action, count(*)::int AS n, max(created_at) AS last_seen
         FROM admin_activity_log GROUP BY action ORDER BY n DESC`);
    res.json({ actions: r.rows, highRisk: [...HIGH_RISK_ACTIONS] });
  } catch (err) { next(err); }
});

// GET /admin/activity-log/report?month=YYYY-MM — the month as a PDF.
//
// The same document that is emailed on the 1st. Available on demand because a
// record you can only get by waiting for an email, and only if that email
// arrived, is not a record you can rely on.
//
// Defaults to LAST month rather than this one: a report of a month still in
// progress is a partial answer that looks like a complete one.
router.get('/report', requireRole('admin'), async (req, res, next) => {
  try {
    const activityReport = require('../utils/activityReport');

    let year;
    let month;
    const asked = String(req.query.month || '').trim();
    if (asked) {
      const m = /^(\d{4})-(\d{2})$/.exec(asked);
      if (!m) return res.status(400).json({ error: 'month must look like 2026-09.' });
      year = Number(m[1]);
      month = Number(m[2]);
      if (month < 1 || month > 12) {
        return res.status(400).json({ error: 'month must be between 01 and 12.' });
      }
    } else {
      ({ year, month } = activityReport.previousMonth());
    }

    const { pdf, filename } = await activityReport.buildForMonth(year, month);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(pdf);
  } catch (err) {
    next(err);
  }
});

module.exports = { router, logActivity, logSubmission, isHighRisk, HIGH_RISK_ACTIONS };
