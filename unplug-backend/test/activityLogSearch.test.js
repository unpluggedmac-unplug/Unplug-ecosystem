// The audit trail: recording where an action came from, and finding it again.
//
// What this file is really protecting:
//
//   1. THE ADDRESS IS RECORDED WITHOUT ANY CALL SITE PASSING IT. logActivity is
//      called from seventy-eight places. If the request context ever stops
//      working, every one of them silently records a blank, and a log with
//      unexplained holes is worse than one with none.
//   2. THE SEARCH BOX CANNOT BE TURNED INTO A QUERY. It takes free text from an
//      admin and puts it in SQL.
//   3. THE FILTERS DO NOT SILENTLY MATCH EVERYTHING. A date filter that fails
//      open shows an admin the wrong window and tells them it is the right one.
//   4. RECORDING NEVER BREAKS THE ACTION IT DESCRIBES.
//
// Run with:  npm test   (from unplug-backend/)

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const EmbeddedPostgres = require('embedded-postgres').default;

let pg;
let pool;
let server;
let baseUrl;
let jwt;
let activityLog;
let requestContext;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-audit-'));
const port = 37600 + (process.pid % 300); // bases are 400 apart so ranges cannot overlap

let adminToken;
let memberToken;

async function get(urlPath, token) {
  const res = await fetch(baseUrl + urlPath, {
    headers: token ? { Authorization: 'Bearer ' + token } : {},
  });
  return { status: res.status, body: await res.json().catch(() => null) };
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
  process.env.JWT_SECRET = 'test-secret-for-audit';
  process.env.UNPLUG_DISABLE_RATE_LIMITS = '1';
  // No alert address: the high-risk mailer must stay switched off unless one
  // is configured, and these tests must not try to send anything.
  delete process.env.UNPLUG_SECURITY_ALERT_EMAIL;

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }

  jwt = require('jsonwebtoken');
  activityLog = require('../src/routes/activityLog');
  requestContext = require('../src/middleware/requestContext');

  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.set('trust proxy', true);
  app.use(requestContext.middleware);
  app.use(express.json());
  app.use(attachUser);

  // A route that logs without being handed an address, exactly as the real
  // seventy-eight call sites do.
  app.post('/pretend-admin-action', (req, res) => {
    activityLog.logActivity(req.user ? req.user.id : null, req.body.action, req.body.details);
    res.json({ done: true });
  });

  app.use('/admin/activity-log', activityLog.router);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await pool.query(`INSERT INTO users (id, email, full_name, password_hash, role)
                    VALUES (551001, 'auditor@test.com', 'Ada Auditor', 'x', 'admin'),
                           (551002, 'other@test.com', 'Otto Other', 'x', 'admin'),
                           (551003, 'member@test.com', 'Mo Member', 'x', 'member')`);
  adminToken = jwt.sign({ id: 551001, email: 'auditor@test.com', role: 'admin' }, process.env.JWT_SECRET);
  memberToken = jwt.sign({ id: 551003, email: 'member@test.com', role: 'member' }, process.env.JWT_SECRET);
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  // Windows can still hold a handle on the data directory when Postgres exits.
  try { if (pg) await pg.stop(); } catch (e) { /* the OS being slow to let go */ }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* as above */ }
});

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

test('THE ADDRESS IS RECORDED THOUGH NO CALL SITE PASSED ONE', async () => {
  // The whole reason for the request context. The route below calls
  // logActivity with three arguments, exactly like the seventy-eight real
  // ones, and the address still lands in the row.
  await fetch(baseUrl + '/pretend-admin-action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + adminToken },
    body: JSON.stringify({ action: 'article_approved', details: 'Article #1' }),
  });
  await new Promise((r) => setTimeout(r, 120)); // the write is not awaited by the route

  const row = (await pool.query(
    `SELECT * FROM admin_activity_log WHERE action = 'article_approved' ORDER BY id DESC LIMIT 1`)).rows[0];
  assert.ok(row, 'the entry exists');
  assert.ok(row.ip_address, `an address was captured, got ${row.ip_address}`);
  assert.ok(row.user_agent !== undefined);
  assert.equal(row.admin_user_id, 551001);
});

test('an IPv4 address is stored in the form somebody would search for', async () => {
  // A v4 client on a dual-stack listener arrives as "::ffff:127.0.0.1".
  // Storing it that way means an address copied from a firewall log never
  // matches.
  const row = (await pool.query(
    `SELECT ip_address FROM admin_activity_log WHERE action = 'article_approved' ORDER BY id DESC LIMIT 1`)).rows[0];
  assert.ok(!String(row.ip_address).startsWith('::ffff:'), `got ${row.ip_address}`);
});

test('HIGH-RISK ACTIONS ARE MARKED, ORDINARY ONES ARE NOT', async () => {
  await activityLog.logActivity(551001, 'user_role_changed', 'member #5 -> admin');
  await activityLog.logActivity(551001, 'article_approved', 'Article #2');

  const risky = (await pool.query(
    `SELECT high_risk FROM admin_activity_log WHERE action = 'user_role_changed' LIMIT 1`)).rows[0];
  const ordinary = (await pool.query(
    `SELECT high_risk FROM admin_activity_log WHERE action = 'article_approved' ORDER BY id DESC LIMIT 1`)).rows[0];

  assert.equal(risky.high_risk, true, 'changing who can do what is worth being told about');
  assert.equal(ordinary.high_risk, false, 'approving an article is not');
});

test('RECORDING NEVER THROWS, EVEN WHEN THE WRITE FAILS', async () => {
  // An audit entry failing must not become the reason the action it describes
  // fails. A null action violates NOT NULL; this must still resolve quietly.
  await assert.doesNotReject(() => activityLog.logActivity(551001, null, 'this cannot be stored'));
});

test('work outside a request records no address rather than inventing one', async () => {
  // A scheduled job genuinely has no originating address. A fabricated one
  // would be the kind of evidence that misleads an investigation.
  await activityLog.logActivity(551001, 'database_cleanup', 'nightly');
  const row = (await pool.query(
    `SELECT ip_address FROM admin_activity_log WHERE action = 'database_cleanup' ORDER BY id DESC LIMIT 1`)).rows[0];
  assert.equal(row.ip_address, null);
});

// ---------------------------------------------------------------------------
// Searching
// ---------------------------------------------------------------------------

test('the listing names the admin, rather than showing a dash', async () => {
  // The screen read a.admin_email and the query returned only an id, so the
  // "By" column had always been empty.
  const r = await get('/admin/activity-log?limit=5', adminToken);
  assert.equal(r.status, 200);
  const mine = r.body.activity.find((a) => a.admin_user_id === 551001);
  assert.equal(mine.admin_email, 'auditor@test.com');
  assert.equal(mine.admin_name, 'Ada Auditor');
});

test('FREE TEXT SEARCHES BOTH THE ACTION AND THE DETAILS', async () => {
  await activityLog.logActivity(551002, 'profile_approved', 'Profile #77 — Nkosi Trading');

  const byDetail = await get('/admin/activity-log?q=Nkosi', adminToken);
  assert.ok(byDetail.body.activity.some((a) => a.details.includes('Nkosi')));

  const byAction = await get('/admin/activity-log?q=profile_appr', adminToken);
  assert.ok(byAction.body.activity.some((a) => a.action === 'profile_approved'));
});

test('A QUOTE IN THE SEARCH BOX IS A SEARCH TERM, NOT SQL', async () => {
  // The one that matters: this endpoint takes free text from a person and puts
  // it in a query.
  const nasty = "'; DROP TABLE admin_activity_log; --";
  const r = await get('/admin/activity-log?q=' + encodeURIComponent(nasty), adminToken);
  assert.equal(r.status, 200, 'it answers rather than erroring');
  assert.equal(r.body.activity.length, 0, 'and finds nothing, because nothing contains that');

  const still = await pool.query(`SELECT count(*)::int AS n FROM admin_activity_log`);
  assert.ok(still.rows[0].n > 0, 'the table is still there');
});

test('filtering by admin returns only that admin', async () => {
  const r = await get('/admin/activity-log?adminUserId=551002', adminToken);
  assert.ok(r.body.activity.length > 0);
  assert.ok(r.body.activity.every((a) => a.admin_user_id === 551002));
});

test('filtering by action returns only that action', async () => {
  const r = await get('/admin/activity-log?action=user_role_changed', adminToken);
  assert.ok(r.body.activity.length > 0);
  assert.ok(r.body.activity.every((a) => a.action === 'user_role_changed'));
});

test('THE HIGH-RISK FILTER SHOWS ONLY WHAT IT PROMISES', async () => {
  const r = await get('/admin/activity-log?highRiskOnly=true', adminToken);
  assert.ok(r.body.activity.length > 0);
  assert.ok(r.body.activity.every((a) => a.high_risk === true));
  assert.ok(r.body.activity.every((a) => activityLog.isHighRisk(a.action)),
    'and the flag agrees with the list the application keeps');
});

test('A DATE FILTER THAT CANNOT BE PARSED FAILS, RATHER THAN MATCHING EVERYTHING', async () => {
  // Failing open here would show an admin the wrong window and give them no
  // reason to doubt it.
  const r = await get('/admin/activity-log?from=not-a-date', adminToken);
  assert.equal(r.status, 500, 'refused');

  const good = await get('/admin/activity-log?from=2000-01-01', adminToken);
  assert.equal(good.status, 200);
  assert.ok(good.body.activity.length > 0);
});

test('a future date range returns nothing at all', async () => {
  const r = await get('/admin/activity-log?from=2099-01-01', adminToken);
  assert.equal(r.status, 200);
  assert.equal(r.body.activity.length, 0);
  assert.equal(r.body.pagination.total, 0);
});

test('paging reports a total that matches the filter, not the table', async () => {
  const all = await get('/admin/activity-log?limit=1', adminToken);
  const filtered = await get('/admin/activity-log?action=user_role_changed&limit=1', adminToken);
  assert.ok(all.body.pagination.total > filtered.body.pagination.total,
    'the count narrows with the filter, or the page numbers are a lie');
  assert.equal(filtered.body.activity.length, 1, 'and the page itself respects the limit');
});

test('the action list is built from what has actually happened', async () => {
  const r = await get('/admin/activity-log/actions', adminToken);
  assert.equal(r.status, 200);
  const names = r.body.actions.map((a) => a.action);
  assert.ok(names.includes('article_approved'));
  assert.ok(names.includes('user_role_changed'));
  assert.ok(r.body.highRisk.includes('user_role_changed'));
});

test('THE WHOLE LOG IS ADMIN-ONLY', async () => {
  assert.equal((await get('/admin/activity-log')).status, 401);
  assert.equal((await get('/admin/activity-log', memberToken)).status, 403);
  assert.equal((await get('/admin/activity-log/actions', memberToken)).status, 403);
});
