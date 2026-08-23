// Running the database cleanup, and seeing what it would do first.
//
// Exposed as an endpoint for the same reason the birthday mailer is: Render's
// free tier sleeps when idle and has no cron, so a timer inside the process
// runs only while somebody happens to be using the site. An external scheduler
// — the same uptime pinger that keeps the instance warm — can call this daily
// and know it actually happened.
//
// Authorised either as an admin, or with UNPLUG_CLEANUP_SECRET as a bearer
// token so a scheduler can call it without an admin login. Idempotent: a
// second run in the same minute deletes nothing, because the first one already
// did.

const express = require('express');
const { runCleanup, rules, ANALYTICS_RETENTION_DAYS, EXPIRED_TOKEN_GRACE_DAYS } = require('../utils/databaseCleanup');
const { requireRole } = require('../middleware/auth');
const { logActivity } = require('./activityLog');

const router = express.Router();

function authorised(req) {
  const secret = process.env.UNPLUG_CLEANUP_SECRET;
  const auth = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const isAdmin = req.user && req.user.role === 'admin';
  const hasSecret = secret && auth && auth === secret;
  return { ok: Boolean(isAdmin || hasSecret), isAdmin };
}

// GET /maintenance/cleanup/preview — admin. What would be removed, and why.
//
// Separate from the run itself so the answer to "what does this delete?" never
// requires deleting anything to find out.
router.get('/cleanup/preview', requireRole('admin'), async (req, res, next) => {
  try {
    const report = await runCleanup({ dryRun: true });
    res.json({
      ...report,
      retention: {
        analyticsDays: ANALYTICS_RETENTION_DAYS,
        expiredTokenGraceDays: EXPIRED_TOKEN_GRACE_DAYS,
      },
    });
  } catch (err) { next(err); }
});

// GET /maintenance/cleanup/rules — admin. The policy, in words, without
// touching the database at all.
router.get('/cleanup/rules', requireRole('admin'), (req, res) => {
  res.json({
    rules: rules().map((r) => ({ table: r.table, where: r.where, why: r.why })),
    // Named explicitly, because "what does this NOT delete" is the question
    // worth being able to answer instantly.
    neverTouched: [
      'votes — they carry the link to what somebody paid for',
      'payments, orders, edition_purchases — financial records',
      'articles, profiles, comments — the publication itself',
      'admin_activity_log — an audit trail with a retention policy set by the audited is not an audit trail',
    ],
  });
});

// POST /maintenance/cleanup — run it.
router.post('/cleanup', async (req, res, next) => {
  try {
    const auth = authorised(req);
    if (!auth.ok) return res.status(401).json({ error: 'Not authorised to run database cleanup.' });

    const report = await runCleanup({ dryRun: false });

    // Worth an audit entry: something deleted rows, and the log should say
    // what and on whose authority.
    if (auth.isAdmin && req.user) {
      logActivity(req.user.id, 'database_cleanup',
        `${report.rowsRemoved} row(s) removed across ${report.tables.filter((t) => t.rows).length} table(s)`);
    }
    console.log(`[cleanup] removed ${report.rowsRemoved} row(s) in ${report.ms}ms`);
    res.json(report);
  } catch (err) { next(err); }
});

module.exports = router;
