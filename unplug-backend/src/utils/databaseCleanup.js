// Database hygiene — pruning what has genuinely expired, then letting
// Postgres reclaim the space.
//
// THE ONLY THINGS DELETED ARE THE ONES NAMED BELOW. This is an allow-list, not
// a pattern. There is no "delete anything older than X" rule anywhere in this
// file, because the moment such a rule exists, a table that should have been
// exempt gets swept up by it and nobody notices until the data is wanted.
//
// WHAT IS DELIBERATELY NOT HERE, and must never be added:
//
//   votes                — period-stamped and kept forever. They carry the
//                          link to what somebody PAID for; deleting an old
//                          one destroys the record of a purchase.
//   payments, orders,
//   edition_purchases    — financial records. Not ours to tidy.
//   articles, profiles,
//   comments             — the publication itself.
//   admin_activity_log   — the audit trail. An audit trail with a retention
//                          policy set by the thing being audited is not an
//                          audit trail.
//
// What IS here falls into two groups: single-use tokens that have expired and
// can never be used again, and high-volume analytics rows past a retention
// window generous enough that no report on the site can reach them.
//
// SAFE TO RUN AT ANY TIME. Every rule is a plain DELETE with an explicit
// predicate; there are no cascades into the tables above, and running it twice
// deletes nothing the second time.

const pool = require('../db');

// Longest window any query on this site looks back over is 30 days. Keeping
// more than a year means a year-on-year comparison is still possible, while
// still bounding growth — these are the tables that get a row per page view.
const ANALYTICS_RETENTION_DAYS = Number(process.env.UNPLUG_ANALYTICS_RETENTION_DAYS || 400);

// A token that expired is dead: it cannot be redeemed, and the row is only
// evidence that somebody once asked for a link. A week's grace means a support
// question about "my link didn't work yesterday" can still be answered.
const EXPIRED_TOKEN_GRACE_DAYS = Number(process.env.UNPLUG_TOKEN_GRACE_DAYS || 7);

// Each rule says what it removes and why. The `why` is not decoration — it is
// what a future reader needs in order to judge whether the rule is still
// correct, and it is printed in the report.
function rules() {
  const tokenCutoff = `now() - INTERVAL '${EXPIRED_TOKEN_GRACE_DAYS} days'`;
  const analyticsCutoff = `now() - INTERVAL '${ANALYTICS_RETENTION_DAYS} days'`;

  return [
    {
      table: 'magic_link_tokens',
      where: `expires_at < ${tokenCutoff}`,
      why: 'a sign-in link that expired over a week ago can never be used again',
    },
    {
      table: 'password_reset_tokens',
      where: `expires_at < ${tokenCutoff}`,
      why: 'an expired reset link is dead, and holding them is a small standing risk',
    },
    {
      table: 'email_verification_codes',
      where: `expires_at < ${tokenCutoff}`,
      why: 'an expired verification code cannot be entered',
    },
    {
      table: 'page_views',
      where: `viewed_at < ${analyticsCutoff}`,
      why: `raw page views past ${ANALYTICS_RETENTION_DAYS} days; the longest report on the site looks back 30`,
    },
    {
      table: 'content_views',
      where: `viewed_at < ${analyticsCutoff}`,
      why: `feeds the "most read in 30 days" homepage row, so anything past ${ANALYTICS_RETENTION_DAYS} days is unreachable`,
    },
    {
      table: 'analytics_events',
      where: `occurred_at < ${analyticsCutoff}`,
      why: `one row per page load; past ${ANALYTICS_RETENTION_DAYS} days nothing queries them`,
    },
    {
      table: 'login_attempts',
      // Only rows already past the reset window, so a live delay is never
      // deleted out from under somebody mid-attack. The row is worthless once
      // the count has reset anyway — check() ignores it.
      where: `last_failed_at < now() - INTERVAL '30 days'`,
      why: 'failed sign-in records that stopped counting weeks ago',
    },
    {
      table: 'not_found_log',
      // Only entries already dealt with. An unresolved miss is a to-do list
      // item, however old, and deleting it loses the reason a redirect was
      // needed in the first place.
      where: `resolved = true AND last_seen_at < now() - INTERVAL '90 days'`,
      why: 'misses that were handled and have not recurred in three months',
    },
    {
      table: 'admin_notifications',
      where: `read = true AND created_at < now() - INTERVAL '180 days'`,
      why: 'notifications an admin has read and not acted on in six months',
    },
  ];
}

async function tableExists(name) {
  const r = await pool.query(
    `SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = $1`, [name]);
  return r.rowCount > 0;
}

async function totalBytes(tables) {
  if (!tables.length) return 0;
  const r = await pool.query(
    `SELECT COALESCE(sum(pg_total_relation_size(c.oid)), 0)::bigint AS bytes
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ANY($1)`, [tables]);
  return Number(r.rows[0].bytes);
}

// Runs the whole sweep.
//
//   { dryRun }  counts what would go without deleting anything.
//
// Returns a report: what was removed from where, and how much space came back.
async function runCleanup({ dryRun = false } = {}) {
  const started = Date.now();
  const applicable = [];
  for (const rule of rules()) {
    // A table named in a rule but not present is not an error — migrations
    // rename things, and a cleanup job is the last thing that should stop a
    // deploy.
    if (await tableExists(rule.table)) applicable.push(rule);
  }

  const tables = applicable.map((r) => r.table);
  const bytesBefore = await totalBytes(tables);

  const results = [];
  for (const rule of applicable) {
    try {
      if (dryRun) {
        const r = await pool.query(`SELECT count(*)::int AS n FROM "${rule.table}" WHERE ${rule.where}`);
        results.push({ table: rule.table, rows: r.rows[0].n, why: rule.why, deleted: false });
      } else {
        const r = await pool.query(`DELETE FROM "${rule.table}" WHERE ${rule.where}`);
        results.push({ table: rule.table, rows: r.rowCount, why: rule.why, deleted: true });
      }
    } catch (err) {
      // One rule failing must not stop the rest. A cleanup that gives up
      // halfway on a bad night is a cleanup that silently stops running.
      console.error(`[cleanup] ${rule.table} failed:`, err.message);
      results.push({ table: rule.table, rows: 0, why: rule.why, error: err.message });
    }
  }

  const removed = results.reduce((sum, r) => sum + (r.rows || 0), 0);

  // VACUUM reclaims the space the deletes freed, and ANALYZE refreshes the
  // statistics the query planner uses — after removing a large share of a
  // table, stale statistics can turn a fast query into a sequential scan.
  //
  // NOT "VACUUM FULL". That one rewrites the table and takes an ACCESS
  // EXCLUSIVE lock, which on a live site means every read of that table blocks
  // until it finishes. Plain VACUUM runs alongside normal traffic and returns
  // the space for reuse, which is what is actually wanted here.
  //
  // It also cannot run inside a transaction block, which is why each is its
  // own statement on its own connection rather than part of a batch.
  const vacuumed = [];
  if (!dryRun && removed > 0) {
    for (const rule of applicable) {
      const r = results.find((x) => x.table === rule.table);
      if (!r || !r.rows) continue; // nothing was deleted, nothing to reclaim
      try {
        await pool.query(`VACUUM (ANALYZE) "${rule.table}"`);
        vacuumed.push(rule.table);
      } catch (err) {
        // Managed Postgres can refuse VACUUM to a non-owner. Autovacuum will
        // get there on its own; the rows are still gone either way.
        console.warn(`[cleanup] could not vacuum ${rule.table}: ${err.message}`);
      }
    }
  }

  const bytesAfter = dryRun ? bytesBefore : await totalBytes(tables);

  return {
    dryRun,
    rowsRemoved: removed,
    // Can be negative or zero even after a big delete: plain VACUUM returns
    // space for REUSE by the same table rather than handing it back to the
    // operating system, so this measures what the file actually gave up. Room
    // freed inside the file is real and is the more common outcome; it just
    // does not show here. Reported as measured rather than as hoped.
    bytesBefore, bytesAfter,
    bytesReclaimed: Math.max(0, bytesBefore - bytesAfter),
    tables: results,
    vacuumed,
    ms: Date.now() - started,
  };
}

module.exports = { runCleanup, rules, ANALYTICS_RETENTION_DAYS, EXPIRED_TOKEN_GRACE_DAYS };
