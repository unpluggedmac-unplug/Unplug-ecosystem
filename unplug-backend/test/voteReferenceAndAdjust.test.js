// TOP 10 — the Reference Code is the entry code, and admin vote adjustments.
//
// The guarantees worth testing hardest:
//   1. Two people buying votes for the SAME contestant must both check out.
//      The reference is now identical for both, and it used to be UNIQUE, so
//      the second purchase would have failed outright on a duplicate key.
//   2. A bare entry code must NOT open or modify a purchase. Entry codes are
//      printed publicly beside every contestant, so if they still worked as
//      the buyer's credential, anyone could read one off the Top 10 page and
//      attach a file to a stranger's order.
//   3. Links already sent out — the old unguessable references — must keep
//      working.
//   4. A vote adjustment must move the real total, be refused without a
//      reason, never drive a total negative, and leave an audit trail.
//
// Over real HTTP against real PostgreSQL. See universalComments.test.js for
// why require('../src/app') is avoided.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-voteref-'));
const port = 23600 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

async function req(method, urlPath, { token, body } = {}) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, body: json };
}

let jwt;
function tokenFor(userId, role = 'member') {
  return jwt.sign({ id: userId, email: `vr${userId}@test.com`, role }, process.env.JWT_SECRET);
}

let _nextUserId = 91000;
async function makeUser(role = 'member') {
  const id = _nextUserId++;
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', $3) ON CONFLICT DO NOTHING`,
    [id, `vr${id}@test.com`, role]
  );
  return id;
}

let adminToken;
let entryId;
const ENTRY_CODE = '0001234567';
const TERMS = { termsAccepted: true, termsVersion: 'v1' };

async function totalVotes(id) {
  const r = await pool.query('SELECT COALESCE(SUM(bundle_size), 0) AS n FROM votes WHERE entry_id = $1', [id]);
  return Number(r.rows[0].n);
}

async function waitForLog(action, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const r = await pool.query('SELECT details FROM admin_activity_log WHERE action = $1 ORDER BY id DESC LIMIT 1', [action]);
    if (r.rowCount) return r.rows[0];
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
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
  process.env.JWT_SECRET = 'test-secret-for-vote-reference';
  process.env.UNPLUG_DISABLE_RATE_LIMITS = '1';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }

  jwt = require('jsonwebtoken');

  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/', require('../src/routes/competitions'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  adminToken = tokenFor(await makeUser('admin'), 'admin');

  const ownerId = await makeUser();
  const profile = await pool.query(
    `INSERT INTO profiles (user_id, type, package_tier, slug, display_name, status)
     VALUES ($1, 'individual', 'basic', 'vr-contestant', 'VR Contestant', 'approved') RETURNING id`,
    [ownerId]
  );
  const comp = await pool.query(
    `INSERT INTO competitions (name, slug, opens_at, closes_at, status)
     VALUES ('VR Comp', 'vr-comp', now(), now() + interval '30 days', 'open') RETURNING id`
  );
  const entry = await pool.query(
    `INSERT INTO competition_entries (competition_id, profile_id, status, entry_code)
     VALUES ($1, $2, 'approved', $3) RETURNING id`,
    [comp.rows[0].id, profile.rows[0].id, ENTRY_CODE]
  );
  entryId = entry.rows[0].id;

  await pool.query('INSERT INTO vote_bundle_tiers (votes, price) VALUES (50, 250) ON CONFLICT DO NOTHING');
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  // Windows can still hold a handle on the data directory when Postgres
  // exits, and embedded-postgres removes that directory as part of
  // stopping. The server is already down by then, so an EBUSY here is
  // the OS being slow to let go, not a failure worth failing the file
  // for — and a teardown that goes red teaches everyone to ignore red.
  try { if (pg) await pg.stop(); } catch (e) { /* see above */ }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* Windows holds the dir briefly */ }
});

let firstToken;

test('the Reference Code is the entry code, exactly', async () => {
  const res = await req('POST', `/entries/${entryId}/vote-bundle`, { body: { votes: 50, sessionId: 'sess-a', ...TERMS } });
  assert.equal(res.status, 201);
  assert.equal(res.body.reference, ENTRY_CODE);
  assert.equal(res.body.entryCode, ENTRY_CODE);
  assert.ok(res.body.lookupToken, 'a private lookup token must come back too');
  assert.notEqual(res.body.lookupToken, res.body.reference);
  firstToken = res.body.lookupToken;
});

test('a second buyer for the same contestant can still check out', async () => {
  // This is the whole risk of making the reference the entry code: the column
  // used to be UNIQUE, so this purchase would have failed on a duplicate key
  // and the customer would have seen a generic checkout error.
  const res = await req('POST', `/entries/${entryId}/vote-bundle`, { body: { votes: 50, sessionId: 'sess-b', ...TERMS } });
  assert.equal(res.status, 201);
  assert.equal(res.body.reference, ENTRY_CODE, 'both buyers quote the same Reference Code');
  assert.notEqual(res.body.lookupToken, firstToken, 'but each order is tracked separately');
});

test('the buyer can check their own purchase with their lookup token', async () => {
  const res = await req('GET', `/vote-bundles/status/${firstToken}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.purchase.vote_count, 50);
  assert.equal(res.body.purchase.entry_code, ENTRY_CODE);
  assert.equal(res.body.purchase.status, 'awaiting_payment');
});

test('a bare entry code cannot be used to open someone else\'s purchase', async () => {
  const res = await req('GET', `/vote-bundles/status/${ENTRY_CODE}`);
  assert.equal(res.status, 404);
  assert.match(res.body.error, /link you were given/i);
});

test('a bare entry code cannot be used to attach proof of payment', async () => {
  const res = await req('PATCH', `/vote-bundles/${ENTRY_CODE}/proof`, { body: { url: 'https://x.test/pop.pdf' } });
  assert.equal(res.status, 404);
  const rows = await pool.query('SELECT pop_url FROM vote_bundles WHERE pop_url IS NOT NULL');
  assert.equal(rows.rowCount, 0, 'nothing should have been attached to anyone');
});

test('the buyer can attach proof with their lookup token', async () => {
  const res = await req('PATCH', `/vote-bundles/${firstToken}/proof`, { body: { url: 'https://x.test/mine.pdf' } });
  assert.equal(res.status, 200);
  const row = await pool.query('SELECT pop_url FROM vote_bundles WHERE lookup_token = $1', [firstToken]);
  assert.equal(row.rows[0].pop_url, 'https://x.test/mine.pdf');
});

test('links already sent out with an old-style reference keep working', async () => {
  // Pre-106 references were unguessable, so they remain valid credentials.
  await pool.query(
    `INSERT INTO vote_bundles (entry_id, session_id, vote_count, price, status, reference, lookup_token)
     VALUES ($1, 'sess-legacy', 10, 50, 'awaiting_payment', '0001234567-K7M2', 'LEGACYTOKEN000000000001')`,
    [entryId]
  );
  const res = await req('GET', '/vote-bundles/status/0001234567-K7M2');
  assert.equal(res.status, 200);
  assert.equal(res.body.purchase.vote_count, 10);
});

test('an admin can add votes, and the total really moves', async () => {
  const before = await totalVotes(entryId);
  const res = await req('POST', `/admin/entries/${entryId}/adjust-votes`, {
    token: adminToken, body: { delta: 25, reason: 'Cash payment taken at the office' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.before, before);
  assert.equal(res.body.after, before + 25);
  assert.equal(await totalVotes(entryId), before + 25);
});

test('an admin can remove votes', async () => {
  const before = await totalVotes(entryId);
  const res = await req('POST', `/admin/entries/${entryId}/adjust-votes`, {
    token: adminToken, body: { delta: -10, reason: 'Duplicate payment reversed' },
  });
  assert.equal(res.status, 200);
  assert.equal(await totalVotes(entryId), before - 10);
});

test('an adjustment cannot take a total below zero', async () => {
  const before = await totalVotes(entryId);
  const res = await req('POST', `/admin/entries/${entryId}/adjust-votes`, {
    token: adminToken, body: { delta: -(before + 1), reason: 'Too far' },
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /below zero/i);
  assert.equal(await totalVotes(entryId), before, 'the total must be untouched');
});

test('an adjustment requires a reason and a non-zero whole number', async () => {
  assert.equal((await req('POST', `/admin/entries/${entryId}/adjust-votes`, {
    token: adminToken, body: { delta: 5 },
  })).status, 400);
  assert.equal((await req('POST', `/admin/entries/${entryId}/adjust-votes`, {
    token: adminToken, body: { delta: 0, reason: 'nothing' },
  })).status, 400);
  assert.equal((await req('POST', `/admin/entries/${entryId}/adjust-votes`, {
    token: adminToken, body: { delta: 2.5, reason: 'half' },
  })).status, 400);
});

test('every adjustment is written to the audit log with both totals', async () => {
  await req('POST', `/admin/entries/${entryId}/adjust-votes`, {
    token: adminToken, body: { delta: 7, reason: 'Manual correction' },
  });
  const row = await waitForLog('entry_votes_adjusted');
  assert.ok(row, 'the adjustment should be logged');
  assert.match(row.details, /Manual correction/);
  assert.match(row.details, /->/, 'the log should record the before and after totals');
});

test('vote adjustment is admin-only', async () => {
  const memberToken = tokenFor(await makeUser('member'), 'member');
  assert.equal((await req('POST', `/admin/entries/${entryId}/adjust-votes`, { body: { delta: 1, reason: 'x' } })).status, 401);
  assert.equal((await req('POST', `/admin/entries/${entryId}/adjust-votes`, { token: memberToken, body: { delta: 1, reason: 'x' } })).status, 403);
});

test('re-running every migration is idempotent', async () => {
  // Migrations run on every deploy with no tracking table, so 106 dropping a
  // constraint and creating indexes has to survive being applied repeatedly.
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }
  const dup = await pool.query(
    `SELECT reference, COUNT(*) FROM vote_bundles WHERE reference = $1 GROUP BY reference`, [ENTRY_CODE]
  );
  assert.equal(Number(dup.rows[0].count), 2, 'the two same-reference orders must both survive a re-run');
});
