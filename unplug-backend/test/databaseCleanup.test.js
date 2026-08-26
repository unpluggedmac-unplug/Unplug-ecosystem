// The database cleanup, against a REAL PostgreSQL.
//
// A job that deletes rows on a schedule is the most dangerous thing in this
// codebase: it runs unattended, and its mistakes are silent and permanent.
// So the tests are mostly about what it must NOT do.
//
//   1. IT DOES NOT TOUCH VOTES. They carry the link to what somebody paid for.
//   2. IT DOES NOT TOUCH THE AUDIT LOG, payments, articles or profiles.
//   3. IT DOES NOT DELETE A TOKEN THAT STILL WORKS.
//   4. IT DOES NOT DELETE ANALYTICS THE SITE STILL READS — the homepage's
//      "most read in 30 days" row is fed by content_views.
//   5. A dry run deletes nothing at all.
//   6. Running it twice is harmless.
//
// Run with:  npm test   (from unplug-backend/)

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const EmbeddedPostgres = require('embedded-postgres').default;
const { stopPostgres } = require('./helpers/stopPostgres');

let pg;
let pool;
let cleanup;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-clean-'));
const port = 36800 + (process.pid % 300); // bases are 400 apart so ranges cannot overlap

async function count(table, where) {
  const r = await pool.query(`SELECT count(*)::int AS n FROM ${table}${where ? ' WHERE ' + where : ''}`);
  return r.rows[0].n;
}

before(async () => {
  pg = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'postgres', password: 'postgres', port,
    persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('unplug_test');

  process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${port}/unplug_test`;
  process.env.JWT_SECRET = 'test-secret-for-cleanup';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }
  cleanup = require('../src/utils/databaseCleanup');

  await pool.query(`INSERT INTO users (id, email, password_hash, role)
                    VALUES (771001, 'clean@test.com', 'x', 'member')`);
});

after(async () => {
  if (pool) await pool.end();
  // stopPostgres, not pg.stop() directly: on Windows the library's stop
  // can HANG rather than throw, which used to leave the cluster running
  // with no parent and eventually broke a later test file's startup.
  // See test/helpers/stopPostgres.js.
  await stopPostgres(pg, dataDir);
});

// ---------------------------------------------------------------------------
// What it must never touch
// ---------------------------------------------------------------------------

test('THE ALLOW-LIST NAMES NO TABLE THAT HOLDS MONEY OR CONTENT', async () => {
  // Read the policy rather than the effect: this fails the moment somebody
  // adds a rule for one of these, instead of the first time it runs in
  // production against real data.
  const forbidden = [
    'votes', 'payments', 'orders', 'edition_purchases', 'articles',
    'profiles', 'comments', 'admin_activity_log', 'users',
    'competition_entries', 'vote_bundles',
  ];
  const targeted = cleanup.rules().map((r) => r.table);
  for (const t of forbidden) {
    assert.ok(!targeted.includes(t), `${t} must never be pruned automatically`);
  }
});

test('every rule explains itself', async () => {
  // The "why" is printed in the report and is what a future reader needs to
  // judge whether a rule is still right. A rule without one is a rule nobody
  // will dare change.
  for (const r of cleanup.rules()) {
    assert.ok(r.why && r.why.length > 20, `${r.table} has a real reason`);
    assert.ok(r.where && r.where.length > 5, `${r.table} has an explicit predicate`);
  }
});

test('AN OLD VOTE SURVIVES THE SWEEP', async () => {
  // The rule from the Top 10: votes are period-stamped and never deleted,
  // because each one is tied to a payment.
  const comp = await pool.query(
    `INSERT INTO competitions (name, slug, description, opens_at, closes_at, status)
     VALUES ('Old Comp', 'old-comp-clean', 'x', now() - INTERVAL '900 days', now() - INTERVAL '870 days', 'closed')
     RETURNING id`);
  const entry = await pool.query(
    `INSERT INTO competition_entries (competition_id, profile_id, manual_name, status)
     VALUES ($1, NULL, 'Someone', 'approved') RETURNING id`, [comp.rows[0].id]);
  await pool.query(
    `INSERT INTO votes (entry_id, session_id, created_at)
     VALUES ($1, 'sess-old-voter', now() - INTERVAL '900 days')`, [entry.rows[0].id]);

  const before = await count('votes');
  await cleanup.runCleanup({});
  assert.equal(await count('votes'), before, 'a two-and-a-half-year-old vote is still there');
});

test('the audit log is not pruned by the thing it audits', async () => {
  await pool.query(
    `INSERT INTO admin_activity_log (admin_user_id, action, details, created_at)
     VALUES (771001, 'ancient_action', 'from long ago', now() - INTERVAL '900 days')`);
  await cleanup.runCleanup({});
  assert.equal(await count('admin_activity_log', `action = 'ancient_action'`), 1);
});

// ---------------------------------------------------------------------------
// What it does remove
// ---------------------------------------------------------------------------

test('A TOKEN THAT STILL WORKS IS NOT DELETED', async () => {
  // The failure that would lock people out: sweeping away a live sign-in link
  // because its row happens to be old.
  await pool.query(
    `INSERT INTO magic_link_tokens (user_id, token, expires_at, created_at)
     VALUES (771001, 'still-valid', now() + INTERVAL '1 hour', now() - INTERVAL '400 days')`);
  await pool.query(
    `INSERT INTO magic_link_tokens (user_id, token, expires_at, created_at)
     VALUES (771001, 'long-dead', now() - INTERVAL '60 days', now() - INTERVAL '61 days')`);

  await cleanup.runCleanup({});

  assert.equal(await count('magic_link_tokens', `token = 'still-valid'`), 1,
    'an unexpired token survives however old the row is');
  assert.equal(await count('magic_link_tokens', `token = 'long-dead'`), 0,
    'an expired one is gone');
});

test('a token that expired yesterday is kept for the grace period', async () => {
  // So "my link did not work yesterday" can still be investigated.
  await pool.query(
    `INSERT INTO magic_link_tokens (user_id, token, expires_at)
     VALUES (771001, 'expired-yesterday', now() - INTERVAL '1 day')`);
  await cleanup.runCleanup({});
  assert.equal(await count('magic_link_tokens', `token = 'expired-yesterday'`), 1);
});

test('ANALYTICS THE HOMEPAGE STILL READS ARE UNTOUCHED', async () => {
  // content_views feeds the "most read in the last 30 days" row. A retention
  // window that reached inside 30 days would quietly empty it.
  await pool.query(
    `INSERT INTO content_views (target_type, target_id, session_id, view_day, viewed_at)
     VALUES ('article', 1, 's1', (now() - INTERVAL '10 days')::date, now() - INTERVAL '10 days')`);
  await pool.query(
    `INSERT INTO content_views (target_type, target_id, session_id, view_day, viewed_at)
     VALUES ('article', 2, 's2', (now() - INTERVAL '500 days')::date, now() - INTERVAL '500 days')`);

  await cleanup.runCleanup({});

  assert.equal(await count('content_views', `target_id = 1`), 1, 'ten days old: still read by the homepage');
  assert.equal(await count('content_views', `target_id = 2`), 0, 'five hundred days old: past retention');
});

test('the retention window is comfortably beyond any query on the site', async () => {
  // The longest look-back in the codebase is 30 days. Anything under a year
  // here would risk a report going quietly empty.
  assert.ok(cleanup.ANALYTICS_RETENTION_DAYS >= 365,
    'analytics are kept for at least a year so year-on-year still works');
});

// ---------------------------------------------------------------------------
// Behaviour of the run itself
// ---------------------------------------------------------------------------

test('A DRY RUN DELETES NOTHING', async () => {
  await pool.query(
    `INSERT INTO magic_link_tokens (user_id, token, expires_at)
     VALUES (771001, 'dry-run-victim', now() - INTERVAL '60 days')`);

  const report = await cleanup.runCleanup({ dryRun: true });
  assert.equal(report.dryRun, true);
  assert.ok(report.rowsRemoved > 0, 'it still says what it would remove');
  assert.equal(await count('magic_link_tokens', `token = 'dry-run-victim'`), 1,
    'and the row is still there');
});

test('running it twice removes nothing the second time', async () => {
  await pool.query(
    `INSERT INTO magic_link_tokens (user_id, token, expires_at)
     VALUES (771001, 'twice', now() - INTERVAL '60 days')`);
  const first = await cleanup.runCleanup({});
  const second = await cleanup.runCleanup({});
  assert.ok(first.rowsRemoved >= 1);
  assert.equal(second.rowsRemoved, 0, 'idempotent, so a scheduler may call it as often as it likes');
});

test('the report says what went, from where, and why', async () => {
  await pool.query(
    `INSERT INTO magic_link_tokens (user_id, token, expires_at)
     VALUES (771001, 'reported', now() - INTERVAL '60 days')`);
  const report = await cleanup.runCleanup({});

  const line = report.tables.find((t) => t.table === 'magic_link_tokens');
  assert.ok(line, 'the table appears in the report');
  assert.ok(line.why, 'with the reason it was pruned');
  assert.ok(typeof report.bytesBefore === 'number' && typeof report.bytesAfter === 'number');
  assert.ok(report.ms >= 0);
  assert.ok(Array.isArray(report.vacuumed));
});

test('a missing table is skipped rather than failing the run', async () => {
  // Migrations rename things. A cleanup job must never be the reason a deploy
  // or a nightly run falls over.
  await pool.query('CREATE TABLE IF NOT EXISTS zzz_temp_check (id int)');
  await pool.query('DROP TABLE zzz_temp_check');
  const report = await cleanup.runCleanup({});
  assert.ok(report.tables.every((t) => !t.error), 'no rule reported an error');
});
