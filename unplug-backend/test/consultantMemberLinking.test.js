// The standing member <-> representative link (users.sales_consultant_id) —
// over real HTTP against real PostgreSQL.
//
// Before this, "is this member X's client" only ever meant "has a confirmed
// payment with sales_consultant_id=X" — real, but derived, with no way for
// an admin to link someone who hasn't paid yet or correct a wrong
// attribution. This pins: an admin can set/clear the link directly via
// PATCH /admin/users/:id, GET /admin/users returns it, a real confirmed
// payment sets it automatically (via applyPaymentEffectTracked), and a
// manually-linked member with NO payment history still shows up as a client
// everywhere clients are listed.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-consultant-member-linking-'));
const port = 24000 + (process.pid % 300);

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

let _nextUserId = 15000;
let _nextRef = 1;
const jwt = require('jsonwebtoken');
function tokenFor(id, email, role) {
  return jwt.sign({ id, email, role }, process.env.JWT_SECRET);
}
async function makeUser(email, role) {
  const id = _nextUserId++;
  await pool.query(`INSERT INTO users (id, email, password_hash, role) VALUES ($1,$2,'x',$3) ON CONFLICT DO NOTHING`, [id, email, role || 'member']);
  return id;
}
async function makeConsultant(name, userId) {
  const r = await pool.query(`INSERT INTO sales_consultants (name, user_id, commission_pct) VALUES ($1,$2,10) RETURNING id`, [name, userId]);
  return r.rows[0].id;
}
async function makePendingEftPayment(payerUserId, consultantId) {
  const r = await pool.query(
    `INSERT INTO payments (user_id, amount, method, gateway_reference, status, linked_type, linked_id, sales_consultant_id)
     VALUES ($1,500,'eft',$2,'pending','profile_package',999999,$3) RETURNING id`,
    [payerUserId, `ref-${_nextRef++}`, consultantId]
  );
  return r.rows[0].id;
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
  process.env.JWT_SECRET = 'test-secret-for-consultant-member-linking';

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
  app.use('/admin', require('../src/routes/admin'));
  app.use('/payments', require('../src/routes/payments'));
  app.use('/growth-application', require('../src/routes/growthApplication').router);
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

test('an admin can link a member to a representative with no payment involved at all', async () => {
  const adminId = await makeUser('admin-link1@test.com', 'admin');
  const consultantUserId = await makeUser('consultant-link1@test.com', 'consultant');
  const consultantId = await makeConsultant('Consultant Link1', consultantUserId);
  const memberId = await makeUser('member-link1@test.com', 'member');

  const { status, body } = await req('PATCH', `/admin/users/${memberId}`, {
    token: tokenFor(adminId, 'admin-link1@test.com', 'admin'),
    body: { salesConsultantId: consultantId },
  });
  assert.equal(status, 200);
  assert.equal(body.user.sales_consultant_id, consultantId);
});

test('linking rejects an unknown consultant id', async () => {
  const adminId = await makeUser('admin-link2@test.com', 'admin');
  const memberId = await makeUser('member-link2@test.com', 'member');
  const { status } = await req('PATCH', `/admin/users/${memberId}`, {
    token: tokenFor(adminId, 'admin-link2@test.com', 'admin'),
    body: { salesConsultantId: 999999 },
  });
  assert.equal(status, 404);
});

test('a member can be unlinked back to null', async () => {
  const adminId = await makeUser('admin-link3@test.com', 'admin');
  const consultantUserId = await makeUser('consultant-link3@test.com', 'consultant');
  const consultantId = await makeConsultant('Consultant Link3', consultantUserId);
  const memberId = await makeUser('member-link3@test.com', 'member');
  const adminToken = tokenFor(adminId, 'admin-link3@test.com', 'admin');

  await req('PATCH', `/admin/users/${memberId}`, { token: adminToken, body: { salesConsultantId: consultantId } });
  const { status, body } = await req('PATCH', `/admin/users/${memberId}`, { token: adminToken, body: { salesConsultantId: null } });
  assert.equal(status, 200);
  assert.equal(body.user.sales_consultant_id, null);
});

test('GET /admin/users returns the linked representative name for each member', async () => {
  const adminId = await makeUser('admin-link4@test.com', 'admin');
  const consultantUserId = await makeUser('consultant-link4@test.com', 'consultant');
  const consultantId = await makeConsultant('Consultant Link4', consultantUserId);
  const memberId = await makeUser('member-link4@test.com', 'member');
  const adminToken = tokenFor(adminId, 'admin-link4@test.com', 'admin');
  await req('PATCH', `/admin/users/${memberId}`, { token: adminToken, body: { salesConsultantId: consultantId } });

  const { status, body } = await req('GET', `/admin/users?q=member-link4@test.com`, { token: adminToken });
  assert.equal(status, 200);
  const found = body.users.find((u) => u.id === memberId);
  assert.ok(found);
  assert.equal(found.sales_consultant_id, consultantId);
  assert.equal(found.sales_consultant_name, 'Consultant Link4');
});

test('a manually-linked member with NO payment history still shows up as a client', async () => {
  const adminId = await makeUser('admin-link5@test.com', 'admin');
  const consultantUserId = await makeUser('consultant-link5@test.com', 'consultant');
  const consultantId = await makeConsultant('Consultant Link5', consultantUserId);
  const memberId = await makeUser('member-link5@test.com', 'member');
  await req('PATCH', `/admin/users/${memberId}`, {
    token: tokenFor(adminId, 'admin-link5@test.com', 'admin'),
    body: { salesConsultantId: consultantId },
  });

  const { status, body } = await req('GET', '/growth-application/consultant/clients', {
    token: tokenFor(consultantUserId, 'consultant-link5@test.com', 'consultant'),
  });
  assert.equal(status, 200);
  assert.equal(body.clients.length, 1);
  assert.equal(body.clients[0].email, 'member-link5@test.com');
  assert.equal(body.clients[0].application_id, null);
});

test('confirming a real EFT payment referred by a consultant sets the payer\'s standing link automatically', async () => {
  const adminId = await makeUser('admin-link6@test.com', 'admin');
  const consultantUserId = await makeUser('consultant-link6@test.com', 'consultant');
  const consultantId = await makeConsultant('Consultant Link6', consultantUserId);
  const memberId = await makeUser('member-link6@test.com', 'member');
  const paymentId = await makePendingEftPayment(memberId, consultantId);

  const { status } = await req('PATCH', `/payments/${paymentId}/confirm-eft`, {
    token: tokenFor(adminId, 'admin-link6@test.com', 'admin'),
  });
  assert.equal(status, 200);

  const row = await pool.query('SELECT sales_consultant_id FROM users WHERE id = $1', [memberId]);
  assert.equal(row.rows[0].sales_consultant_id, consultantId);
});

test('a later payment confirmed for a DIFFERENT consultant updates the standing link to the new one', async () => {
  const adminId = await makeUser('admin-link7@test.com', 'admin');
  const consultantAUserId = await makeUser('consultant-link7a@test.com', 'consultant');
  const consultantAId = await makeConsultant('Consultant Link7A', consultantAUserId);
  const consultantBUserId = await makeUser('consultant-link7b@test.com', 'consultant');
  const consultantBId = await makeConsultant('Consultant Link7B', consultantBUserId);
  const memberId = await makeUser('member-link7@test.com', 'member');
  const adminToken = tokenFor(adminId, 'admin-link7@test.com', 'admin');

  await req('PATCH', `/admin/users/${memberId}`, { token: adminToken, body: { salesConsultantId: consultantAId } });
  const paymentId = await makePendingEftPayment(memberId, consultantBId);
  await req('PATCH', `/payments/${paymentId}/confirm-eft`, { token: adminToken });

  const row = await pool.query('SELECT sales_consultant_id FROM users WHERE id = $1', [memberId]);
  assert.equal(row.rows[0].sales_consultant_id, consultantBId);
});
