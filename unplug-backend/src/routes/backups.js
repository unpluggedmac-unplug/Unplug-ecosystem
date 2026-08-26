// Backups, seen from the admin dashboard.
//
// WHAT IS DELIBERATELY NOT HERE: a restore button.
//
// A control that replaces the entire live database in one click is a control
// worth stealing. During this same piece of work two stored cross-site
// scripting holes were found in the admin dashboard, one of them reachable by
// anyone on the internet through the public contact form. A restore endpoint
// existing then would have meant a hijacked admin session could wipe the site
// and replace it with three-week-old data.
//
// Restoring therefore requires shell access to the server —
// scripts/restore-backup.js — which somebody who has borrowed a browser
// session does not have. That is a real guard rather than a dialog box.
//
// What IS here: take a backup now, see what exists, download one, and export
// the data. All of those are additive or read-only. The worst a stolen session
// achieves is a copy of data it could already read through the dashboard.

const express = require('express');
const { requireRole } = require('../middleware/auth');
const { logActivity } = require('./activityLog');
const runner = require('../utils/backupRunner');

const router = express.Router();

// GET /backups — what exists, where, and whether it is actually working.
router.get('/', requireRole('admin'), async (req, res, next) => {
  try {
    const inventory = await runner.inventory();
    const configured = inventory.some((d) => !d.warning && !d.error);
    res.json({
      destinations: inventory,
      // The thing an admin most needs to know and is least likely to check.
      offsite: configured,
      note: configured
        ? null
        : 'Backups are being written to the local disk only, which Render wipes '
          + 'on every deploy. Configure R2 or B2 before relying on these.',
      keep: runner.KEEP,
    });
  } catch (err) { next(err); }
});

// POST /backups/run — take one now.
//
// Additive: it creates a file and never removes anything until the new one is
// verified and stored. Safe for an admin to press, and safe to press twice.
router.post('/run', requireRole('admin'), async (req, res, next) => {
  try {
    const report = await runner.run();
    logActivity(req.user.id, 'backup_taken',
      `${report.filename} — ${report.rows} rows to ${report.destinations.filter((d) => d.ok).map((d) => d.provider).join(', ')}`);
    res.json(report);
  } catch (err) {
    // The message matters here: the usual failure is a missing passphrase, and
    // that has a specific fix.
    res.status(500).json({ error: err.message });
  }
});

// GET /backups/:key/download — the decrypted SQL, for somebody who wants to
// look inside or restore by hand.
//
// It is decrypted server-side because the passphrase lives on the server and
// must not travel to a browser. The response is the plain dump, so an admin
// downloading one is holding every member email on the site — which is why it
// is admin-only and why taking one is written to the audit log.
router.get('/:key/download', requireRole('admin'), async (req, res, next) => {
  try {
    const key = String(req.params.key);
    if (!/^unplug-[\w:.-]+\.unplugbk$/.test(key)) {
      return res.status(400).json({ error: 'That is not a backup filename.' });
    }
    const { sql, provider } = await runner.fetchDecrypted(key);

    logActivity(req.user.id, 'backup_downloaded', `${key} from ${provider}`);
    res.set('Content-Type', 'application/sql; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${key.replace('.unplugbk', '.sql')}"`);
    res.send(sql);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// GET /backups/export — a fresh export, without storing it anywhere.
//
//   ?parts=data       just the rows (the default)
//   ?parts=config     just the settings table and the like
//
// The "media" part of a full export is deliberately absent: images live in
// Supabase Storage, they are already off this server, and streaming several
// gigabytes of them through a 512 MB instance to produce one archive is how
// an export request becomes an outage. OPERATIONS.md says how to copy the
// bucket directly instead.
router.get('/export', requireRole('admin'), async (req, res, next) => {
  try {
    const parts = String(req.query.parts || 'data');
    const backupDump = require('../utils/backupDump');

    const tables = parts === 'config'
      ? ['settings', 'cms_blocks', 'service_packages'].filter(Boolean)
      : undefined;

    res.set('Content-Type', 'application/sql; charset=utf-8');
    res.set('Content-Disposition',
      `attachment; filename="unplug-export-${parts}-${new Date().toISOString().slice(0, 10)}.sql"`);

    // Streamed straight to the response rather than assembled in memory: an
    // export is the largest thing this instance ever produces.
    const summary = await backupDump.dumpTo((chunk) => res.write(chunk), { tables });
    res.end();
    logActivity(req.user.id, 'data_exported', `${parts}: ${summary.rows} rows`);
  } catch (err) {
    // Headers may already be sent by the time this fails, in which case the
    // download simply ends short — which is why the dump writes its COMMIT
    // last and a truncated file is detectable.
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.end();
  }
});

module.exports = router;
