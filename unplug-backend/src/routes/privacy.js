const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const { publicSubmitLimiter } = require('../middleware/rateLimit');

const router = express.Router();

// ---------------------------------------------------------------------------
// TABLES THIS EXPORT MUST NEVER INCLUDE.
//
// Everything else is discovered at runtime (see below), so this list is the
// only thing standing between a member's download and the secrets that let
// somebody become them. Each entry is here for a specific reason:
//
//   password_reset_tokens / magic_link_tokens  — a live token IS a sign-in.
//   email_verification_codes                   — same.
//   two_factor_recovery_codes                  — bypasses the second factor.
//   spam_tokens                                — form tokens; not their data.
//   login_attempts                             — holds IPs, and is a security
//                                                record about the account
//                                                rather than content of theirs.
//   admin_activity_log                         — about admins, and would leak
//                                                moderation notes on others.
//   analytics_sessions / analytics_events /
//   page_views / content_views                 — the anonymous analytics.
//                                                Including them would rebuild
//                                                a browsing history that was
//                                                deliberately never linked to
//                                                a person.
//
// A file the member can hand to anybody must not be a way to take over their
// account.
// ---------------------------------------------------------------------------
const NEVER_EXPORT = new Set([
  'password_reset_tokens',
  'magic_link_tokens',
  'email_verification_codes',
  'two_factor_recovery_codes',
  'spam_tokens',
  'login_attempts',
  'admin_activity_log',
  'analytics_sessions',
  'analytics_events',
  'page_views',
  'content_views',
  'csp_reports',
  'not_found_log',
]);

// Columns stripped from the users row itself.
const NEVER_EXPORT_COLUMNS = new Set([
  'password_hash',
  'two_factor_secret',
  'two_factor_last_token',
]);

// A cap so one member with a lot of history cannot ask the API to assemble an
// unbounded response and take the instance down with it. Render's free tier
// has 512 MB.
const ROW_CAP = 1000;

// Postgres identifiers from information_schema are real table names, but they
// are still interpolated into SQL, so they are checked rather than trusted.
const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/;

// ---------------------------------------------------------------------------
// POST /privacy/consent — public. Records a consent decision.
//
// The browser still keeps its own copy in localStorage; that is what gates the
// tracker on the next page load without a round trip. This is the RECORD, and
// the two answer different questions: localStorage answers "may I track this
// page view", the table answers "can you show that they agreed, and to what".
// ---------------------------------------------------------------------------
router.post('/consent', publicSubmitLimiter, async (req, res, next) => {
  try {
    const choice = req.body && req.body.choice;
    if (choice !== 'accepted' && choice !== 'declined') {
      return res.status(400).json({ error: 'choice must be "accepted" or "declined".' });
    }
    // Whatever the browser says its key is, capped. It is opaque to us.
    const visitorKey = String((req.body && req.body.visitorKey) || '').slice(0, 64) || null;
    const version = await policyVersion();

    await pool.query(
      `INSERT INTO consent_records (user_id, visitor_key, choice, policy_version, source, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        req.user ? req.user.id : null,
        visitorKey,
        choice,
        version,
        'bar',
        String(req.get('user-agent') || '').slice(0, 400) || null,
      ]
    );
    res.status(201).json({ recorded: true, policyVersion: version });
  } catch (err) {
    next(err);
  }
});

// GET /privacy/policy-version — public. The consent bar asks again when the
// version it recorded is older than this one.
router.get('/policy-version', async (req, res, next) => {
  try {
    res.json({ policyVersion: await policyVersion() });
  } catch (err) {
    next(err);
  }
});

async function policyVersion() {
  try {
    const r = await pool.query(`SELECT value FROM settings WHERE key = 'privacy_policy_version'`);
    return (r.rows[0] && r.rows[0].value) || '1';
  } catch (err) {
    return '1';
  }
}

// ---------------------------------------------------------------------------
// GET /privacy/export — the signed-in member's own data, as JSON.
//
// THE TABLE LIST IS DISCOVERED, NOT WRITTEN DOWN.
//
// There are about 180 tables. A hand-maintained list of the ones holding
// member data would be correct on the day it was written and wrong within a
// month — and an export that silently omits data is worse than no export at
// all, because it is offered as a complete answer.
//
// So: every table with a user_id or author_user_id column is included
// automatically, minus NEVER_EXPORT above. A new feature that stores something
// against a member appears in the export without anybody remembering to add
// it, which is the only version of this that stays true.
// ---------------------------------------------------------------------------
router.get('/export', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.id;

    const me = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    if (me.rows.length === 0) return res.status(404).json({ error: 'Account not found.' });
    const account = { ...me.rows[0] };
    NEVER_EXPORT_COLUMNS.forEach((c) => { delete account[c]; });

    const owned = await pool.query(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_name IN ('user_id', 'author_user_id')
        ORDER BY table_name, column_name`
    );

    const data = {};
    const skipped = [];
    const truncated = [];

    for (const row of owned.rows) {
      const table = row.table_name;
      const column = row.column_name;
      if (NEVER_EXPORT.has(table)) { skipped.push(table); continue; }
      if (!SAFE_IDENT.test(table) || !SAFE_IDENT.test(column)) continue;

      try {
        const result = await pool.query(
          `SELECT * FROM "${table}" WHERE "${column}" = $1 LIMIT ${ROW_CAP + 1}`, [userId]
        );
        if (result.rows.length === 0) continue;
        if (result.rows.length > ROW_CAP) {
          truncated.push(table);
          result.rows.length = ROW_CAP;
        }
        // Two columns can both point at users on the same table; merge rather
        // than letting the second query overwrite the first.
        data[table] = (data[table] || []).concat(result.rows);
      } catch (err) {
        // A table we cannot read must not fail the whole export. Losing one
        // section is recoverable; a 500 leaves the member with nothing.
        skipped.push(table + ' (unreadable)');
      }
    }

    const consent = await pool.query(
      `SELECT choice, policy_version, source, created_at
         FROM consent_records WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200`, [userId]
    );

    res.setHeader('Content-Disposition',
      `attachment; filename="unplug-my-data-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json({
      exportedAt: new Date().toISOString(),
      account,
      consentHistory: consent.rows,
      data,
      notes: {
        // Said plainly in the file itself, so the person reading it knows what
        // it does and does not contain without having to ask.
        excluded: 'Sign-in tokens, verification codes, two-factor recovery codes and security logs are deliberately left out — this file should not be a way to take over your account. Anonymous analytics are also excluded: they were never linked to you.',
        rowLimitPerSection: ROW_CAP,
        truncatedSections: truncated,
        skippedTables: skipped,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.NEVER_EXPORT = NEVER_EXPORT;
