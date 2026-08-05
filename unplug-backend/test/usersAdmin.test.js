// Admin management of user accounts, over real HTTP against real PostgreSQL.
//
// Two areas here can do real damage, so both are tested as the mistakes they
// have to survive:
//
//   ROLES — an admin changing their own role locks themselves out of the
//   dashboard they are standing in, and there is no way back through the UI.
//
//   CREDIT — account credit is money the customer can spend at checkout. It
//   must never go negative, must never be adjusted without a stated reason,
//   and two admins adjusting at once must not both read the same old balance.
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
let adminToken;
let memberToken;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-usertest-'));
const port = 8400 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

async function req(method, urlPath, { token, body } = {}) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, body: json };
}

const MEMBER_ID = 20;

before(async () => {
  pg = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'postgres', password: 'postgres', port,
    persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('unplug_test');

  process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${port}/unplug_test`;
  process.env.JWT_SECRET = 'test-secret-for-users-admin';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }
  await pool.query(`INSERT INTO users (id, email, password_hash, role)
                    VALUES (1, 'admin@test.com', 'x', 'admin'),
                           (2, 'admin2@test.com', 'x', 'admin'),
                           (${MEMBER_ID}, 'member@test.com', 'x', 'member')
                    ON CONFLICT DO NOTHING`);

  const jwt = require('jsonwebtoken');
  adminToken = jwt.sign({ id: 1, email: 'admin@test.com', role: 'admin' }, process.env.JWT_SECRET);
  memberToken = jwt.sign({ id: MEMBER_ID, email: 'member@test.com', role: 'member' }, process.env.JWT_SECRET);

  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/admin', require('../src/routes/admin'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}, { timeout: 120000 });

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (pool) await pool.end();
  if (pg) await pg.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- permissions

test('members and visitors cannot manage accounts', async () => {
  assert.equal((await req('GET', '/admin/users', { token: memberToken })).status, 403);
  assert.equal((await req('PATCH', `/admin/users/${MEMBER_ID}`, { token: memberToken, body: { role: 'admin' } })).status, 403);
  assert.equal((await req('POST', `/admin/users/${MEMBER_ID}/credits`, { token: memberToken, body: { amount: 1000, note: 'free money' } })).status, 403);
  assert.equal((await req('GET', '/admin/users')).status, 401);

  const role = await pool.query('SELECT role FROM users WHERE id = $1', [MEMBER_ID]);
  assert.equal(role.rows[0].role, 'member', 'a member promoted themselves to admin');
});

// ----------------------------------------------------------------------- list

test('the list carries the credit balance as a number, not a string', async () => {
  await pool.query(
    `INSERT INTO account_credits (user_id, amount, reason, note, created_by)
     VALUES ($1, 150.00, 'admin_adjustment', 'seed', 1)`, [MEMBER_ID]
  );
  const r = await req('GET', '/admin/users', { token: adminToken });
  const member = r.body.users.find((u) => u.id === MEMBER_ID);
  assert.equal(typeof member.credit_balance, 'number', 'credit arrived as a string and would render wrong');
  assert.equal(member.credit_balance, 150);
});

// ----------------------------------------------------------------------- edit

test('admin can change a name, phone, role and member type', async () => {
  const r = await req('PATCH', `/admin/users/${MEMBER_ID}`, {
    token: adminToken,
    body: { fullName: 'Thandi Mokoena', phone: '0821234567', role: 'investor', memberType: 'business' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.full_name, 'Thandi Mokoena');
  assert.equal(r.body.user.role, 'investor');
  assert.equal(r.body.user.member_type, 'business');
});

test('fields that were not sent are left alone', async () => {
  await req('PATCH', `/admin/users/${MEMBER_ID}`, { token: adminToken, body: { phone: '0839999999' } });
  const row = await pool.query('SELECT full_name, role FROM users WHERE id = $1', [MEMBER_ID]);
  assert.equal(row.rows[0].full_name, 'Thandi Mokoena', 'an unrelated edit wiped the name');
  assert.equal(row.rows[0].role, 'investor', 'an unrelated edit reset the role');
});

test('an admin cannot change their OWN role and lock themselves out', async () => {
  const r = await req('PATCH', '/admin/users/1', { token: adminToken, body: { role: 'member' } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /lock you out/i);

  const still = await pool.query('SELECT role FROM users WHERE id = 1');
  assert.equal(still.rows[0].role, 'admin', 'the admin demoted themselves');
});

test('one admin can still change ANOTHER admin, so a real mistake is fixable', async () => {
  const r = await req('PATCH', '/admin/users/2', { token: adminToken, body: { role: 'member' } });
  assert.equal(r.status, 200);
  await req('PATCH', '/admin/users/2', { token: adminToken, body: { role: 'admin' } });
});

test('an invalid role or member type is refused', async () => {
  assert.equal((await req('PATCH', `/admin/users/${MEMBER_ID}`, { token: adminToken, body: { role: 'superuser' } })).status, 400);
  assert.equal((await req('PATCH', `/admin/users/${MEMBER_ID}`, { token: adminToken, body: { memberType: 'charity' } })).status, 400);
});

test('the email address cannot be changed here', async () => {
  // It is how sign-in works and how guest edition purchases are reunited with
  // an account — changing it would detach someone from their own history.
  const r = await req('PATCH', `/admin/users/${MEMBER_ID}`, {
    token: adminToken, body: { email: 'someone-else@test.com' },
  });
  assert.equal(r.status, 400);
  const row = await pool.query('SELECT email FROM users WHERE id = $1', [MEMBER_ID]);
  assert.equal(row.rows[0].email, 'member@test.com');
});

// --------------------------------------------------------------------- credit

test('admin can add credit, and it shows in the balance and the history', async () => {
  const r = await req('POST', `/admin/users/${MEMBER_ID}/credits`, {
    token: adminToken, body: { amount: 50, note: 'Goodwill after a delayed edition' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.balance, 200); // 150 seeded + 50

  const view = await req('GET', `/admin/users/${MEMBER_ID}/credits`, { token: adminToken });
  assert.equal(view.body.balance, 200);
  assert.ok(view.body.history.some((h) => /Goodwill/.test(h.note || '')), 'the reason was not recorded');
});

test('credit cannot be adjusted without a reason', async () => {
  const r = await req('POST', `/admin/users/${MEMBER_ID}/credits`, { token: adminToken, body: { amount: 25 } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /note/i);
});

test('a zero adjustment is refused', async () => {
  assert.equal((await req('POST', `/admin/users/${MEMBER_ID}/credits`, {
    token: adminToken, body: { amount: 0, note: 'nothing' },
  })).status, 400);
});

test('credit can be taken back, but never below zero', async () => {
  const ok = await req('POST', `/admin/users/${MEMBER_ID}/credits`, {
    token: adminToken, body: { amount: -50, note: 'Reversing a duplicate credit' },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.balance, 150);

  const tooMuch = await req('POST', `/admin/users/${MEMBER_ID}/credits`, {
    token: adminToken, body: { amount: -1000, note: 'Trying to overdraw' },
  });
  assert.equal(tooMuch.status, 400);

  const after = await req('GET', `/admin/users/${MEMBER_ID}/credits`, { token: adminToken });
  assert.equal(after.body.balance, 150, 'the balance moved despite the adjustment being refused');
});

test('two simultaneous adjustments cannot both spend the same balance', async () => {
  // Both ask to remove R100 from a R150 balance. Read-then-write would let both
  // through and land at -R50; the FOR UPDATE lock means exactly one wins.
  const [a, b] = await Promise.all([
    req('POST', `/admin/users/${MEMBER_ID}/credits`, { token: adminToken, body: { amount: -100, note: 'race A' } }),
    req('POST', `/admin/users/${MEMBER_ID}/credits`, { token: adminToken, body: { amount: -100, note: 'race B' } }),
  ]);
  const succeeded = [a, b].filter((r) => r.status === 200).length;
  assert.equal(succeeded, 1, 'both concurrent adjustments succeeded');

  const final = await req('GET', `/admin/users/${MEMBER_ID}/credits`, { token: adminToken });
  assert.equal(final.body.balance, 50);
  assert.ok(final.body.balance >= 0, 'the balance went negative');
});

test('credit history is admin-only', async () => {
  assert.equal((await req('GET', `/admin/users/${MEMBER_ID}/credits`, { token: memberToken })).status, 403);
  assert.equal((await req('GET', `/admin/users/${MEMBER_ID}/credits`)).status, 401);
});
