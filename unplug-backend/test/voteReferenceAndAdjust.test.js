// TOP 10 — admin vote adjustments after retirement of bulk voting.
//
// Bulk-vote purchase routes, tables and pricing tiers were deliberately removed.
// This file protects the remaining supported behaviour: authorised manual vote
// adjustments must move the real total safely and leave an audit trail.
//
// Over real HTTP against real PostgreSQL.
//
// Run with: npm test (from unplug-backend/)

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const EmbeddedPostgres = require('embedded-postgres').default;
const { stopPostgres } = require('./helpers/stopPostgres');

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
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  // stopPostgres, not pg.stop() directly: on Windows the library's stop
  // can HANG rather than throw, which used to leave the cluster running
  // with no parent and eventually broke a later test file's startup.
  // See test/helpers/stopPostgres.js.
  await stopPostgres(pg, dataDir);
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

test('re-running every migration is idempotent and keeps adjustment votes', async () => {
  const before = await totalVotes(entryId);
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }
  assert.equal(await totalVotes(entryId), before,
    're-running migrations must not remove supported normal/admin-adjustment votes');
});
