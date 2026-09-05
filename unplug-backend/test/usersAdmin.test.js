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
const { stopPostgres } = require('./helpers/stopPostgres');

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
  // stopPostgres, not pg.stop() directly: on Windows the library's stop
  // can HANG rather than throw, which used to leave the cluster running
  // with no parent and eventually broke a later test file's startup.
  // See test/helpers/stopPostgres.js.
  await stopPostgres(pg, dataDir);
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

test('the list is paginated: total reflects everyone, but a page returns only limit rows', async () => {
  for (let i = 0; i < 12; i++) {
    await pool.query(
      `INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', 'member') ON CONFLICT DO NOTHING`,
      [200 + i, `page-user-${i}@test.com`]
    );
  }
  const r = await req('GET', '/admin/users?limit=5&offset=0', { token: adminToken });
  assert.equal(r.status, 200);
  assert.equal(r.body.users.length, 5);
  assert.equal(r.body.limit, 5);
  assert.equal(r.body.offset, 0);
  assert.ok(r.body.total >= 15); // 3 seeded + 12 just inserted

  const page2 = await req('GET', '/admin/users?limit=5&offset=5', { token: adminToken });
  assert.equal(page2.body.users.length, 5);
  // No overlap between the two pages.
  const idsPage1 = new Set(r.body.users.map((u) => u.id));
  assert.ok(page2.body.users.every((u) => !idsPage1.has(u.id)));
});

test('a huge limit is clamped rather than trusted, and a nonsense offset does not error', async () => {
  const r = await req('GET', '/admin/users?limit=999999&offset=abc', { token: adminToken });
  assert.equal(r.status, 200);
  assert.equal(r.body.limit, 200); // clamped
  assert.equal(r.body.offset, 0); // non-numeric offset falls back to 0
});

test('q searches by email or name, server-side, and only matching accounts are returned', async () => {
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role, full_name) VALUES (300, 'searchable@test.com', 'x', 'member', 'Zanele Unique Name') ON CONFLICT DO NOTHING`
  );
  const byEmail = await req('GET', '/admin/users?q=searchable', { token: adminToken });
  assert.ok(byEmail.body.users.some((u) => u.id === 300));
  assert.ok(byEmail.body.users.every((u) => u.email.includes('searchable') || (u.full_name || '').includes('searchable')));

  const byName = await req('GET', '/admin/users?q=Zanele%20Unique', { token: adminToken });
  assert.ok(byName.body.users.some((u) => u.id === 300));

  const noMatch = await req('GET', '/admin/users?q=definitely-nobody-has-this-string', { token: adminToken });
  assert.equal(noMatch.body.users.length, 0);
  assert.equal(noMatch.body.total, 0);
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

// ------------------------------------------------------------- consultant role

test('only an @unplugnews.com account can be made a Sales Consultant', async () => {
  const r = await req('PATCH', `/admin/users/${MEMBER_ID}`, { token: adminToken, body: { role: 'consultant' } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /@unplugnews\.com/);

  const still = await pool.query('SELECT role FROM users WHERE id = $1', [MEMBER_ID]);
  assert.notEqual(still.rows[0].role, 'consultant', 'the role was changed despite the refusal');
});

test('an @unplugnews.com account CAN be made a Sales Consultant', async () => {
  await pool.query(`INSERT INTO users (id, email, password_hash, role)
                    VALUES (777, 'rep@unplugnews.com', 'x', 'member') ON CONFLICT DO NOTHING`);
  const r = await req('PATCH', '/admin/users/777', { token: adminToken, body: { role: 'consultant' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.role, 'consultant');
});

test('the domain check is case-insensitive', async () => {
  await pool.query(`INSERT INTO users (id, email, password_hash, role)
                    VALUES (778, 'Rep2@UnplugNews.Com', 'x', 'member') ON CONFLICT DO NOTHING`);
  const r = await req('PATCH', '/admin/users/778', { token: adminToken, body: { role: 'consultant' } });
  assert.equal(r.status, 200);
});

test('a lookalike domain is refused, not just a missing @unplugnews.com suffix', async () => {
  // Guards against a naive .includes('unplugnews.com') check, which
  // 'rep@unplugnews.com.evil.example' would pass.
  await pool.query(`INSERT INTO users (id, email, password_hash, role)
                    VALUES (779, 'rep@unplugnews.com.evil.example', 'x', 'member') ON CONFLICT DO NOTHING`);
  const r = await req('PATCH', '/admin/users/779', { token: adminToken, body: { role: 'consultant' } });
  assert.equal(r.status, 400);
});

// -------------------------------------------------- per-consultant toggle
//
// Free publishing used to be all-or-nothing for the whole 'consultant' role.
// This lets an admin revoke it from one specific person without demoting
// them out of the role entirely — see 176_consultant_free_publishing_toggle.sql.

test('A NEW ACCOUNT DEFAULTS TO free_publishing_enabled = TRUE — nothing changes until an admin explicitly turns it off', async () => {
  const row = await pool.query('SELECT free_publishing_enabled FROM users WHERE id = $1', [MEMBER_ID]);
  assert.equal(row.rows[0].free_publishing_enabled, true);
});

test('AN ADMIN CAN TURN OFF FREE PUBLISHING FOR ONE CONSULTANT, WITHOUT TOUCHING THEIR ROLE', async () => {
  await pool.query(`INSERT INTO users (id, email, password_hash, role)
                    VALUES (780, 'rep3@unplugnews.com', 'x', 'consultant') ON CONFLICT DO NOTHING`);
  const r = await req('PATCH', '/admin/users/780', { token: adminToken, body: { freePublishingEnabled: false } });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.free_publishing_enabled, false);
  assert.equal(r.body.user.role, 'consultant', 'the role itself must be untouched by this toggle');

  const row = await pool.query('SELECT role, free_publishing_enabled FROM users WHERE id = 780');
  assert.equal(row.rows[0].role, 'consultant');
  assert.equal(row.rows[0].free_publishing_enabled, false);
});

test('IT CAN BE TURNED BACK ON JUST AS EASILY', async () => {
  await req('PATCH', '/admin/users/780', { token: adminToken, body: { freePublishingEnabled: false } });
  const r = await req('PATCH', '/admin/users/780', { token: adminToken, body: { freePublishingEnabled: true } });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.free_publishing_enabled, true);
});

test('A MEMBER CANNOT TOGGLE IT — same admin-only gate as every other field on this route', async () => {
  const r = await req('PATCH', '/admin/users/780', { token: memberToken, body: { freePublishingEnabled: false } });
  assert.equal(r.status, 403);
});

test('THE ACCOUNT LIST CARRIES THE FLAG, SO THE ADMIN UI CAN SHOW ITS REAL STATE WITHOUT A SEPARATE FETCH', async () => {
  const r = await req('GET', '/admin/users?q=rep3@unplugnews.com', { token: adminToken });
  assert.equal(r.status, 200);
  assert.equal(r.body.users[0].free_publishing_enabled, true, 'reflects the "turned back on" state from the test above');
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
