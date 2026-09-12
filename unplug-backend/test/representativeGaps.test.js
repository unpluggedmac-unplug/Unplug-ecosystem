// Covers the second round of Sales Consultant / Agreement Forms / Growth
// Application gap-fixes, all over real HTTP against real PostgreSQL:
//   - POST /admin/links/promote-member — one-step "add + link" a member as
//     a representative, instead of the existing two-step add-then-link flow.
//   - GET /agreement-forms/consultant/clients + the admin equivalent
//     (GET /admin/sales-consultants/:id/agreement-clients) — which of a
//     consultant's referred clients have signed which agreements.
//   - GET /sales-consultants/me/visits + the admin equivalent
//     (GET /admin/sales-consultants/:id/visits) — site visits via a
//     consultant's personal utm_campaign=consultant-<id> tracked link.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-representative-gaps-'));
const port = 21000 + (process.pid % 300);

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

let _nextUserId = 11000;
let _nextRef = 1;
const jwt = require('jsonwebtoken');
function tokenFor(id, email, role) {
  return jwt.sign({ id, email, role }, process.env.JWT_SECRET);
}
async function makeUser(email, role, fullName) {
  const id = _nextUserId++;
  await pool.query(`INSERT INTO users (id, email, password_hash, role, full_name) VALUES ($1,$2,'x',$3,$4) ON CONFLICT DO NOTHING`,
    [id, email, role || 'member', fullName || null]);
  return id;
}
async function makeConsultant(name, userId) {
  const r = await pool.query(
    `INSERT INTO sales_consultants (name, user_id, commission_pct) VALUES ($1,$2,10) RETURNING id`,
    [name, userId]
  );
  return r.rows[0].id;
}
async function makeConfirmedPayment(payerUserId, consultantId) {
  await pool.query(
    `INSERT INTO payments (user_id, amount, method, gateway_reference, status, linked_type, linked_id, sales_consultant_id, confirmed_at)
     VALUES ($1,500,'eft',$2,'confirmed','profile_package',1,$3,now())`,
    [payerUserId, `ref-${_nextRef++}`, consultantId]
  );
}
async function makeSignedAgreement(userId, title) {
  const agreement = await pool.query(
    `INSERT INTO agreement_forms (name, slug, title, signer_type, status, published)
     VALUES ($1,$2,$3,'individual','active',true) RETURNING id`,
    [title, `slug-${_nextRef}`, title]
  );
  await pool.query(
    `INSERT INTO agreement_submissions (agreement_id, user_id, reference, signer_name, signature_type, signature_text, status, payment_status, agreement_version, title_at_signing, signed_at, submitted_at)
     VALUES ($1,$2,$3,'Test Signer','typed','Test Signer','complete','not_required',1,$4,now(),now())`,
    [agreement.rows[0].id, userId, `AGR-${_nextRef++}`, title]
  );
}
async function makeAnalyticsVisits(campaign, count) {
  for (let i = 0; i < count; i++) {
    await pool.query(
      `INSERT INTO analytics_sessions (session_id, visitor_id, campaign, source) VALUES ($1,$2,$3,'Representative')`,
      [`sess-${campaign}-${i}-${_nextRef++}`, `visitor-${campaign}-${i}`, campaign]
    );
  }
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
  process.env.JWT_SECRET = 'test-secret-for-representative-gaps';

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
  app.use('/admin/links', require('../src/routes/adminProfileLinks'));
  app.use('/admin', require('../src/routes/admin'));
  app.use('/agreement-forms', require('../src/routes/agreementForms').router);
  app.use('/sales-consultants', require('../src/routes/salesConsultants'));
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

// --- POST /admin/links/promote-member ---------------------------------------

test('promote-member requires admin', async () => {
  const memberId = await makeUser('plain@test.com', 'member');
  const { status } = await req('POST', '/admin/links/promote-member', { token: tokenFor(memberId, 'plain@test.com', 'member'), body: { userId: memberId } });
  assert.equal(status, 403);
});

test('promote-member creates a sales_consultants record already linked to the member', async () => {
  const adminId = await makeUser('admin-p@test.com', 'admin');
  const memberId = await makeUser('promote-me@test.com', 'member', 'Promote Me');
  const { status, body } = await req('POST', '/admin/links/promote-member', {
    token: tokenFor(adminId, 'admin-p@test.com', 'admin'),
    body: { userId: memberId, commissionPct: 15 },
  });
  assert.equal(status, 201);
  assert.equal(body.consultant.user_id, memberId);
  assert.equal(body.consultant.name, 'Promote Me');
  assert.equal(Number(body.consultant.commission_pct), 15);
});

test('promote-member refuses to double-promote the same member', async () => {
  const adminId = await makeUser('admin-p2@test.com', 'admin');
  const memberId = await makeUser('already-promoted@test.com', 'member');
  await req('POST', '/admin/links/promote-member', { token: tokenFor(adminId, 'admin-p2@test.com', 'admin'), body: { userId: memberId } });
  const { status, body } = await req('POST', '/admin/links/promote-member', { token: tokenFor(adminId, 'admin-p2@test.com', 'admin'), body: { userId: memberId } });
  assert.equal(status, 409);
  assert.match(body.error, /already a representative/);
});

test('promote-member 404s on an unknown user id', async () => {
  const adminId = await makeUser('admin-p3@test.com', 'admin');
  const { status } = await req('POST', '/admin/links/promote-member', { token: tokenFor(adminId, 'admin-p3@test.com', 'admin'), body: { userId: 999999 } });
  assert.equal(status, 404);
});

// --- Agreement-signing status per client ------------------------------------

test('GET /agreement-forms/consultant/clients shows which referred clients have signed which agreements', async () => {
  const consultantUserId = await makeUser('consultant-agr@test.com', 'consultant');
  const consultantId = await makeConsultant('Consultant Agr', consultantUserId);
  const signedClient = await makeUser('signed-client@test.com', 'member', 'Signed Client');
  const unsignedClient = await makeUser('unsigned-client@test.com', 'member', 'Unsigned Client');
  await makeConfirmedPayment(signedClient, consultantId);
  await makeConfirmedPayment(unsignedClient, consultantId);
  await makeSignedAgreement(signedClient, 'Sponsorship Agreement');

  const { status, body } = await req('GET', '/agreement-forms/consultant/clients', { token: tokenFor(consultantUserId, 'consultant-agr@test.com', 'consultant') });
  assert.equal(status, 200);
  assert.equal(body.clients.length, 2);
  const signed = body.clients.find((c) => c.email === 'signed-client@test.com');
  assert.equal(signed.submissions.length, 1);
  assert.equal(signed.submissions[0].agreement_title, 'Sponsorship Agreement');
  assert.equal(signed.submissions[0].status, 'complete');
  const unsigned = body.clients.find((c) => c.email === 'unsigned-client@test.com');
  assert.deepEqual(unsigned.submissions, []);
});

test('the admin equivalent (GET /admin/sales-consultants/:id/agreement-clients) shows the same data, admin-gated', async () => {
  const consultantUserId = await makeUser('consultant-agr2@test.com', 'consultant');
  const consultantId = await makeConsultant('Consultant Agr2', consultantUserId);
  const client = await makeUser('agr-client-b@test.com', 'member');
  await makeConfirmedPayment(client, consultantId);
  await makeSignedAgreement(client, 'NDA');

  const denied = await req('GET', `/admin/sales-consultants/${consultantId}/agreement-clients`, { token: tokenFor(consultantUserId, 'consultant-agr2@test.com', 'consultant') });
  assert.equal(denied.status, 403);

  const adminId = await makeUser('admin-agr@test.com', 'admin');
  const { status, body } = await req('GET', `/admin/sales-consultants/${consultantId}/agreement-clients`, { token: tokenFor(adminId, 'admin-agr@test.com', 'admin') });
  assert.equal(status, 200);
  assert.equal(body.clients.length, 1);
  assert.equal(body.clients[0].submissions[0].agreement_title, 'NDA');
});

// --- Site visits via a consultant's personal link ---------------------------

test('GET /sales-consultants/me/visits counts sessions tagged with this consultant\'s campaign', async () => {
  const consultantUserId = await makeUser('consultant-visits@test.com', 'consultant');
  const consultantId = await makeConsultant('Consultant Visits', consultantUserId);
  await makeAnalyticsVisits(`consultant-${consultantId}`, 3);
  await makeAnalyticsVisits('consultant-999999', 5); // a different consultant's campaign — must not leak in

  const { status, body } = await req('GET', '/sales-consultants/me/visits', { token: tokenFor(consultantUserId, 'consultant-visits@test.com', 'consultant') });
  assert.equal(status, 200);
  assert.equal(body.totalVisits, 3);
  assert.equal(body.campaign, `consultant-${consultantId}`);
});

test('GET /sales-consultants/me/visits 404s when no consultant record is linked', async () => {
  const userId = await makeUser('no-consultant@test.com', 'consultant');
  const { status } = await req('GET', '/sales-consultants/me/visits', { token: tokenFor(userId, 'no-consultant@test.com', 'consultant') });
  assert.equal(status, 404);
});

test('the admin equivalent (GET /admin/sales-consultants/:id/visits) shows the same count, admin-gated', async () => {
  const consultantUserId = await makeUser('consultant-visits2@test.com', 'consultant');
  const consultantId = await makeConsultant('Consultant Visits2', consultantUserId);
  await makeAnalyticsVisits(`consultant-${consultantId}`, 2);

  const denied = await req('GET', `/admin/sales-consultants/${consultantId}/visits`, { token: tokenFor(consultantUserId, 'consultant-visits2@test.com', 'consultant') });
  assert.equal(denied.status, 403);

  const adminId = await makeUser('admin-visits@test.com', 'admin');
  const { status, body } = await req('GET', `/admin/sales-consultants/${consultantId}/visits`, { token: tokenFor(adminId, 'admin-visits@test.com', 'admin') });
  assert.equal(status, 200);
  assert.equal(body.totalVisits, 2);
});

test('the admin visits endpoint 404s on an unknown consultant id', async () => {
  const adminId = await makeUser('admin-visits2@test.com', 'admin');
  const { status } = await req('GET', '/admin/sales-consultants/999999/visits', { token: tokenFor(adminId, 'admin-visits2@test.com', 'admin') });
  assert.equal(status, 404);
});
