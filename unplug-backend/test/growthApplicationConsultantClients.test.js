// Sales-consultant visibility into referred clients' Growth Applications —
// both the consultant's own self-service view (GET
// /growth-application/consultant/clients) and the admin's equivalent (GET
// /admin/sales-consultants/:id/growth-clients).
//
// "Client" here means exactly what /sales-consultants/me already means by
// "referral": a user whose payment carries this consultant's
// sales_consultant_id — reusing that existing attribution rather than
// inventing a separate consultant<->client linking table.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-growth-consultant-clients-'));
const port = 20000 + (process.pid % 300);

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

let _nextUserId = 9000;
let _nextRef = 1;
async function makeUser(email, role) {
  const id = _nextUserId++;
  await pool.query(`INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', $3) ON CONFLICT DO NOTHING`, [id, email, role || 'member']);
  return id;
}
async function makeConsultant(name, userId) {
  const r = await pool.query(
    `INSERT INTO sales_consultants (name, user_id, commission_pct) VALUES ($1, $2, 10) RETURNING id`,
    [name, userId]
  );
  return r.rows[0].id;
}
async function makeConfirmedPayment(payerUserId, consultantId) {
  await pool.query(
    `INSERT INTO payments (user_id, amount, method, gateway_reference, status, linked_type, linked_id, sales_consultant_id, confirmed_at)
     VALUES ($1, 500, 'eft', $2, 'confirmed', 'profile_package', 1, $3, now())`,
    [payerUserId, `ref-${_nextRef++}`, consultantId]
  );
}
async function makeGrowthApplication(userId, status) {
  await pool.query(
    `INSERT INTO growth_applications (user_id, applicant_email, applicant_type, status)
     VALUES ($1, 'x@test.com', 'individual', $2)`,
    [userId, status]
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
  process.env.JWT_SECRET = 'test-secret-for-growth-consultant-clients';

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
  app.use('/growth-application', require('../src/routes/growthApplication').router);
  app.use('/admin', require('../src/routes/admin'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}, { timeout: 120000 });

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('GET /growth-application/consultant/clients requires authentication', async () => {
  const { status } = await req('GET', '/growth-application/consultant/clients');
  assert.equal(status, 401);
});

test('a non-consultant role is rejected', async () => {
  const memberId = await makeUser('plain-member@test.com', 'member');
  const jwt = require('jsonwebtoken');
  const token = jwt.sign({ id: memberId, email: 'plain-member@test.com', role: 'member' }, process.env.JWT_SECRET);
  const { status } = await req('GET', '/growth-application/consultant/clients', { token });
  assert.equal(status, 403);
});

test('a consultant with no linked sales_consultants record sees an empty list, not an error', async () => {
  const userId = await makeUser('unlinked-consultant@test.com', 'consultant');
  const jwt = require('jsonwebtoken');
  const token = jwt.sign({ id: userId, email: 'unlinked-consultant@test.com', role: 'consultant' }, process.env.JWT_SECRET);
  const { status, body } = await req('GET', '/growth-application/consultant/clients', { token });
  assert.equal(status, 200);
  assert.deepEqual(body.clients, []);
});

test('a consultant sees their referred clients, with and without a started Growth Application', async () => {
  const consultantUserId = await makeUser('consultant-a@test.com', 'consultant');
  const consultantId = await makeConsultant('Consultant A', consultantUserId);

  const clientWithApp = await makeUser('client-with-app@test.com');
  const clientNoApp = await makeUser('client-no-app@test.com');
  await makeConfirmedPayment(clientWithApp, consultantId);
  await makeConfirmedPayment(clientNoApp, consultantId);
  await makeGrowthApplication(clientWithApp, 'under_review');

  // A referral with no confirmed payment (still pending) must not leak in.
  const notYetConfirmed = await makeUser('client-pending@test.com');
  await pool.query(
    `INSERT INTO payments (user_id, amount, method, gateway_reference, status, linked_type, linked_id, sales_consultant_id)
     VALUES ($1, 500, 'eft', $2, 'pending', 'profile_package', 1, $3)`,
    [notYetConfirmed, `ref-${_nextRef++}`, consultantId]
  );

  const jwt = require('jsonwebtoken');
  const token = jwt.sign({ id: consultantUserId, email: 'consultant-a@test.com', role: 'consultant' }, process.env.JWT_SECRET);
  const { status, body } = await req('GET', '/growth-application/consultant/clients', { token });
  assert.equal(status, 200);
  assert.equal(body.clients.length, 2);

  const withApp = body.clients.find((c) => c.email === 'client-with-app@test.com');
  assert.equal(withApp.status, 'under_review');
  assert.ok(withApp.application_id);

  const noApp = body.clients.find((c) => c.email === 'client-no-app@test.com');
  assert.equal(noApp.application_id, null);

  assert.ok(!body.clients.some((c) => c.email === 'client-pending@test.com'), 'an unconfirmed referral must not appear');
});

test('the admin equivalent (GET /admin/sales-consultants/:id/growth-clients) shows the same data, gated to admins', async () => {
  const consultantUserId = await makeUser('consultant-b@test.com', 'consultant');
  const consultantId = await makeConsultant('Consultant B', consultantUserId);
  const client = await makeUser('client-b@test.com');
  await makeConfirmedPayment(client, consultantId);
  await makeGrowthApplication(client, 'contacted');

  const jwt = require('jsonwebtoken');
  const consultantToken = jwt.sign({ id: consultantUserId, email: 'consultant-b@test.com', role: 'consultant' }, process.env.JWT_SECRET);
  const denied = await req('GET', `/admin/sales-consultants/${consultantId}/growth-clients`, { token: consultantToken });
  assert.equal(denied.status, 403, 'a consultant must not read this admin-only route');

  const adminId = await makeUser('admin-a@test.com', 'admin');
  const adminToken = jwt.sign({ id: adminId, email: 'admin-a@test.com', role: 'admin' }, process.env.JWT_SECRET);
  const { status, body } = await req('GET', `/admin/sales-consultants/${consultantId}/growth-clients`, { token: adminToken });
  assert.equal(status, 200);
  assert.equal(body.consultant.name, 'Consultant B');
  assert.equal(body.clients.length, 1);
  assert.equal(body.clients[0].status, 'contacted');
});

test('an unknown consultant id 404s on the admin route', async () => {
  const adminId = await makeUser('admin-b@test.com', 'admin');
  const jwt = require('jsonwebtoken');
  const adminToken = jwt.sign({ id: adminId, email: 'admin-b@test.com', role: 'admin' }, process.env.JWT_SECRET);
  const { status } = await req('GET', '/admin/sales-consultants/999999/growth-clients', { token: adminToken });
  assert.equal(status, 404);
});
