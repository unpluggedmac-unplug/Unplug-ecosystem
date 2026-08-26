// ACQUISITION + COMMISSION ATTRIBUTION.
//
// This decides who gets PAID, so the precedence is tested exhaustively rather
// than by example. The owner's rule (2026-08-13): the consultant a member
// picks at signup earns commission on their payments, unless an admin
// reassigns them.
//
//   1. admin assignment   beats  2. signup choice   beats  3. checkout pick
//
// The guarantees worth testing hardest:
//   1. Every one of those six precedence combinations resolves the way the
//      owner described — including the empty cases.
//   2. An anonymous buyer still works: no user, no assignment, checkout pick
//      is all there is.
//   3. An inactive consultant is never credited. Quietly accruing commission
//      to someone who has left is worse than crediting nobody.
//   4. Assignment is recorded with who changed it and from whom — a payout
//      dispute is otherwise unanswerable.
//   5. A member cannot silently rewrite their own answer to redirect
//      commission.
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
const { stopPostgres } = require('./helpers/stopPostgres');

let pg;
let pool;
let server;
let baseUrl;
let attribution;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-acq-'));
const port = 25200 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

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
  return jwt.sign({ id: userId, email: `aq${userId}@test.com`, role }, process.env.JWT_SECRET);
}

let _nextUserId = 131000;
async function makeUser(role = 'member') {
  const id = _nextUserId++;
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role, full_name)
     VALUES ($1, $2, 'x', $3, $4) ON CONFLICT DO NOTHING`,
    [id, `aq${id}@test.com`, role, `Member ${id}`]
  );
  return id;
}

async function makeConsultant(name, active = true) {
  const r = await pool.query(
    'INSERT INTO sales_consultants (name, active) VALUES ($1, $2) RETURNING id', [name, active]
  );
  return r.rows[0].id;
}

let adminToken;
let consultantA;
let consultantB;
let inactiveConsultant;

before(async () => {
  pg = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'postgres', password: 'postgres', port,
    persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('unplug_test');

  process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${port}/unplug_test`;
  process.env.JWT_SECRET = 'test-secret-for-acquisition';
  process.env.UNPLUG_DISABLE_RATE_LIMITS = '1';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }

  jwt = require('jsonwebtoken');
  attribution = require('../src/utils/consultantAttribution');

  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/acquisition', require('../src/routes/acquisition'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  adminToken = tokenFor(await makeUser('admin'), 'admin');
  consultantA = await makeConsultant('Consultant Alpha');
  consultantB = await makeConsultant('Consultant Beta');
  inactiveConsultant = await makeConsultant('Consultant Retired', false);
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

// --- The precedence table, case by case ------------------------------------

test('signup choice beats the checkout pick', async () => {
  // The owner's rule in one line: what the member said at signup is who earns
  // it, even if a different consultant is selected at checkout.
  const userId = await makeUser();
  await pool.query('UPDATE users SET acquisition_source = $2, acquisition_consultant_id = $3 WHERE id = $1',
    [userId, 'sales_consultant', consultantA]);

  const r = await attribution.attributeConsultant(userId, consultantB, pool);
  assert.equal(r.consultantId, consultantA);
  assert.equal(r.source, 'member_signup');
});

test('an admin assignment beats the signup choice', async () => {
  const userId = await makeUser();
  await pool.query('UPDATE users SET acquisition_source = $2, acquisition_consultant_id = $3 WHERE id = $1',
    [userId, 'sales_consultant', consultantA]);
  await pool.query('UPDATE users SET assigned_consultant_id = $2 WHERE id = $1', [userId, consultantB]);

  const r = await attribution.attributeConsultant(userId, null, pool);
  assert.equal(r.consultantId, consultantB, 'the admin decision wins');
  assert.equal(r.source, 'admin_assignment');
});

test('an admin assignment beats the checkout pick too', async () => {
  const userId = await makeUser();
  await pool.query('UPDATE users SET assigned_consultant_id = $2 WHERE id = $1', [userId, consultantA]);
  const r = await attribution.attributeConsultant(userId, consultantB, pool);
  assert.equal(r.consultantId, consultantA);
  assert.equal(r.source, 'admin_assignment');
});

test('with no assignment and no signup answer, the checkout pick stands', async () => {
  // Today's behaviour, unchanged — this is the path every existing payment
  // took, and it must keep working exactly as it did.
  const userId = await makeUser();
  const r = await attribution.attributeConsultant(userId, consultantB, pool);
  assert.equal(r.consultantId, consultantB);
  assert.equal(r.source, 'checkout_selection');
});

test('with nothing anywhere, nobody is credited', async () => {
  const userId = await makeUser();
  const r = await attribution.attributeConsultant(userId, null, pool);
  assert.equal(r.consultantId, null);
  assert.equal(r.source, null);
});

test('an anonymous buyer falls back to the checkout pick', async () => {
  const r = await attribution.attributeConsultant(null, consultantA, pool);
  assert.equal(r.consultantId, consultantA);
  assert.equal(r.source, 'checkout_selection');
});

test('an inactive consultant is never credited, at any level', async () => {
  // Someone switched off has usually left. Accruing commission to them
  // silently is worse than crediting nobody, at every level of the ladder.
  const viaSignup = await makeUser();
  await pool.query('UPDATE users SET acquisition_consultant_id = $2 WHERE id = $1', [viaSignup, inactiveConsultant]);
  assert.equal((await attribution.attributeConsultant(viaSignup, null, pool)).consultantId, null);

  const viaAssignment = await makeUser();
  await pool.query('UPDATE users SET assigned_consultant_id = $2 WHERE id = $1', [viaAssignment, inactiveConsultant]);
  assert.equal((await attribution.attributeConsultant(viaAssignment, null, pool)).consultantId, null);

  const viaCheckout = await makeUser();
  assert.equal((await attribution.attributeConsultant(viaCheckout, inactiveConsultant, pool)).consultantId, null);
});

// --- The member-facing side -------------------------------------------------

test('the dropdown options are public and list only active consultants', async () => {
  const res = await req('GET', '/acquisition/options');
  assert.equal(res.status, 200);
  const names = res.body.consultants.map((c) => c.name);
  assert.ok(names.includes('Consultant Alpha'));
  assert.ok(!names.includes('Consultant Retired'), 'an inactive consultant must not be offered');
  // Nothing commercially sensitive leaks to an anonymous visitor.
  assert.deepEqual(Object.keys(res.body.consultants[0]).sort(), ['id', 'name']);
});

test('a member records how they heard about us, and it sets commission', async () => {
  const userId = await makeUser();
  const res = await req('PUT', '/acquisition/me', {
    token: tokenFor(userId), body: { source: 'sales_consultant', consultantId: consultantA },
  });
  assert.equal(res.status, 200);

  const r = await attribution.attributeConsultant(userId, null, pool);
  assert.equal(r.consultantId, consultantA);
  assert.equal(r.source, 'member_signup');
});

test('a member cannot silently rewrite their answer to redirect commission', async () => {
  const userId = await makeUser();
  await req('PUT', '/acquisition/me', { token: tokenFor(userId), body: { source: 'sales_consultant', consultantId: consultantA } });
  const second = await req('PUT', '/acquisition/me', {
    token: tokenFor(userId), body: { source: 'sales_consultant', consultantId: consultantB },
  });
  assert.equal(second.status, 409);

  const r = await attribution.attributeConsultant(userId, null, pool);
  assert.equal(r.consultantId, consultantA, 'the original answer must stand');
});

test('choosing "a consultant" without naming one is refused', async () => {
  const userId = await makeUser();
  const res = await req('PUT', '/acquisition/me', { token: tokenFor(userId), body: { source: 'sales_consultant' } });
  assert.equal(res.status, 400);
});

// --- The admin side ---------------------------------------------------------

test('an admin assignment is recorded with who moved it and from whom', async () => {
  const userId = await makeUser();
  await req('POST', `/acquisition/admin/assign/${userId}`, {
    token: adminToken, body: { consultantId: consultantA, reason: 'Took over the account' },
  });
  const moved = await req('POST', `/acquisition/admin/assign/${userId}`, {
    token: adminToken, body: { consultantId: consultantB, reason: 'Alpha left' },
  });
  assert.equal(moved.status, 200);

  const hist = await req('GET', `/acquisition/admin/assign/${userId}/history`, { token: adminToken });
  assert.equal(hist.body.history.length, 2);
  assert.equal(hist.body.history[0].from_name, 'Consultant Alpha');
  assert.equal(hist.body.history[0].to_name, 'Consultant Beta');
  assert.equal(hist.body.history[0].reason, 'Alpha left');
  assert.ok(hist.body.history[0].admin_email);
});

test('a member cannot be assigned to an inactive consultant', async () => {
  const userId = await makeUser();
  const res = await req('POST', `/acquisition/admin/assign/${userId}`, {
    token: adminToken, body: { consultantId: inactiveConsultant },
  });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /not an active consultant/i);
});

test('clearing an assignment falls back to the signup choice', async () => {
  const userId = await makeUser();
  await pool.query('UPDATE users SET acquisition_consultant_id = $2 WHERE id = $1', [userId, consultantA]);
  await req('POST', `/acquisition/admin/assign/${userId}`, { token: adminToken, body: { consultantId: consultantB } });
  assert.equal((await attribution.attributeConsultant(userId, null, pool)).consultantId, consultantB);

  const cleared = await req('POST', `/acquisition/admin/assign/${userId}`, { token: adminToken, body: { consultantId: null } });
  assert.equal(cleared.status, 200);
  const r = await attribution.attributeConsultant(userId, null, pool);
  assert.equal(r.consultantId, consultantA);
  assert.equal(r.source, 'member_signup');
});

test('the admin member list spells out who would be credited next', async () => {
  const userId = await makeUser();
  await pool.query('UPDATE users SET acquisition_consultant_id = $2 WHERE id = $1', [userId, consultantA]);
  const res = await req('GET', `/acquisition/admin/members?q=aq${userId}@test.com`, { token: adminToken });
  assert.equal(res.status, 200);
  const row = res.body.members.find((m) => m.id === userId);
  assert.equal(row.commissionOwner, 'Consultant Alpha');
  assert.equal(row.commissionSource, 'member_signup');
});

// --- Referral clicks and shares ---------------------------------------------

test('a referral click is recorded, and an unknown code is not distinguishable', async () => {
  const referrer = await makeUser();
  await pool.query(
    `INSERT INTO member_participation_profiles (user_id, referral_code) VALUES ($1, 'CLICKTEST1')
     ON CONFLICT (user_id) DO UPDATE SET referral_code = 'CLICKTEST1'`,
    [referrer]
  );
  const real = await req('POST', '/acquisition/referral-clicks', { body: { code: 'CLICKTEST1' } });
  const fake = await req('POST', '/acquisition/referral-clicks', { body: { code: 'NOTAREALCODE' } });
  assert.equal(real.status, 200);
  assert.equal(fake.status, 200, 'a fake code must answer identically, or codes can be enumerated');

  const stats = await req('GET', '/acquisition/referral-clicks/mine', { token: tokenFor(referrer) });
  assert.equal(stats.body.clicks, 1);
  assert.equal(stats.body.conversionRate, 0);
});

test('a member with no clicks reads 0%, not NaN', async () => {
  const stats = await req('GET', '/acquisition/referral-clicks/mine', { token: tokenFor(await makeUser()) });
  assert.equal(stats.body.clicks, 0);
  assert.equal(stats.body.conversionRate, 0);
});

test('shares are recorded and summarised, and a bad type is refused', async () => {
  const userId = await makeUser();
  await req('POST', '/acquisition/shares', { token: tokenFor(userId), body: { shareType: 'badge', entityId: 3, channel: 'whatsapp' } });
  await req('POST', '/acquisition/shares', { body: { shareType: 'profile', channel: 'facebook' } });
  const bad = await req('POST', '/acquisition/shares', { token: tokenFor(userId), body: { shareType: 'nonsense' } });
  assert.equal(bad.status, 400);

  const res = await req('GET', '/acquisition/admin/shares', { token: adminToken });
  assert.equal(res.body.total, 2);
  assert.ok(res.body.byChannel.some((c) => c.channel === 'whatsapp'));
});

test('admin endpoints are admin-only', async () => {
  const memberToken = tokenFor(await makeUser('member'), 'member');
  assert.equal((await req('GET', '/acquisition/admin/members')).status, 401);
  assert.equal((await req('GET', '/acquisition/admin/members', { token: memberToken })).status, 403);
  assert.equal((await req('POST', '/acquisition/admin/assign/1', { token: memberToken, body: { consultantId: 1 } })).status, 403);
  assert.equal((await req('GET', '/acquisition/admin/analytics', { token: memberToken })).status, 403);
});

test('re-running every migration is idempotent', async () => {
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }
  const n = await pool.query('SELECT COUNT(*)::int AS n FROM consultant_assignment_history');
  assert.ok(n.rows[0].n > 0, 'assignment history must survive a migration re-run');
});
