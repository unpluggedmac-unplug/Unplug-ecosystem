// Sales consultant self-service: GET /sales-consultants/me — over real HTTP
// against real PostgreSQL.
//
// Before this route existed, a consultant had NO way to see their own
// referral count or commission owed without asking an admin — everything
// under /admin/sales-consultants/* is admin-only. This pins the self-service
// route: scoped strictly to the caller's OWN linked consultant record (via
// sales_consultants.user_id), never another consultant's, and 404s clearly
// when no admin has linked the account yet rather than returning empty data
// that could be misread as "you have zero sales".
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-consultants-me-'));
const port = 12400 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

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

let _nextUserId = 5000;
let _nextRef = 1;
async function makeUser(email) {
  const id = _nextUserId++;
  await pool.query(`INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', 'consultant') ON CONFLICT DO NOTHING`, [id, email]);
  return id;
}
async function makeConsultant(name, userId, commissionPct) {
  const r = await pool.query(
    `INSERT INTO sales_consultants (name, user_id, commission_pct) VALUES ($1, $2, $3) RETURNING id`,
    [name, userId, commissionPct != null ? commissionPct : 10]
  );
  return r.rows[0].id;
}
async function makeConfirmedPayment(payerUserId, consultantId, amount) {
  await pool.query(
    `INSERT INTO payments (user_id, amount, method, gateway_reference, status, linked_type, linked_id, sales_consultant_id, confirmed_at)
     VALUES ($1, $2, 'eft', $3, 'confirmed', 'profile_package', 1, $4, now())`,
    [payerUserId, amount, `ref-${_nextRef++}`, consultantId]
  );
}
async function makePendingPayment(payerUserId, consultantId, amount) {
  await pool.query(
    `INSERT INTO payments (user_id, amount, method, gateway_reference, status, linked_type, linked_id, sales_consultant_id)
     VALUES ($1, $2, 'eft', $3, 'pending', 'profile_package', 1, $4)`,
    [payerUserId, amount, `ref-${_nextRef++}`, consultantId]
  );
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
  process.env.JWT_SECRET = 'test-secret-for-consultants-me';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }

  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/sales-consultants', require('../src/routes/salesConsultants'));
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

test('GET /sales-consultants/me requires authentication', async () => {
  const { status } = await req('GET', '/sales-consultants/me');
  assert.equal(status, 401);
});

test('a signed-in user with no linked consultant record gets a clear 404, not empty data', async () => {
  const userId = await makeUser('unlinked@test.com');
  const jwt = require('jsonwebtoken');
  const token = jwt.sign({ id: userId, email: 'unlinked@test.com', role: 'consultant' }, process.env.JWT_SECRET);

  const { status, body } = await req('GET', '/sales-consultants/me', { token });
  assert.equal(status, 404);
  assert.match(body.error, /not linked|ask an admin/i);
});

test('a linked consultant sees their own confirmed revenue, commission, and recent sales — pending payments do not count toward revenue', async () => {
  const consultantUserId = await makeUser('linked@test.com');
  const payer = await makeUser('payer@test.com');
  const consultantId = await makeConsultant('Jordan Rep', consultantUserId, 10);

  await makeConfirmedPayment(payer, consultantId, 500);
  await makeConfirmedPayment(payer, consultantId, 300);
  await makePendingPayment(payer, consultantId, 1000);

  const jwt = require('jsonwebtoken');
  const token = jwt.sign({ id: consultantUserId, email: 'linked@test.com', role: 'consultant' }, process.env.JWT_SECRET);

  const { status, body } = await req('GET', '/sales-consultants/me', { token });
  assert.equal(status, 200);
  assert.equal(body.consultant.name, 'Jordan Rep');
  assert.equal(body.consultant.confirmed_referrals, 2);
  assert.equal(body.consultant.pending_referrals, 1);
  assert.equal(Number(body.consultant.revenue), 800);
  assert.equal(Number(body.consultant.commission_due), 80); // 10% of 800
  assert.equal(body.recentSales.length, 2);
  // No email/user_id leaked to the consultant themselves — they only need
  // their own performance numbers, not internal linkage details.
  assert.equal(body.consultant.email, undefined);
});

test('a consultant cannot see another consultant\'s numbers through /me', async () => {
  const userA = await makeUser('a@test.com');
  const userB = await makeUser('b@test.com');
  const payer = await makeUser('payer2@test.com');
  const consultantA = await makeConsultant('Consultant A', userA, 10);
  const consultantB = await makeConsultant('Consultant B', userB, 20);

  await makeConfirmedPayment(payer, consultantA, 1000);
  await makeConfirmedPayment(payer, consultantB, 9000);

  const jwt = require('jsonwebtoken');
  const tokenA = jwt.sign({ id: userA, email: 'a@test.com', role: 'consultant' }, process.env.JWT_SECRET);

  const { body } = await req('GET', '/sales-consultants/me', { token: tokenA });
  assert.equal(body.consultant.name, 'Consultant A');
  assert.equal(Number(body.consultant.revenue), 1000); // not 9000 — B's numbers never appear
});
