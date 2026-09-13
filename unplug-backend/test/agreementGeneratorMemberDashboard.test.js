// Agreement Generator — member-dashboard access to a signed-in member's own
// submissions, over real HTTP + real PostgreSQL.
//
// Choice 14 of the Control Centre redesign ("Should Party B be able to save
// and continue later?") was answered: yes, via auto-save drafts, a secure
// resume link, AND member-dashboard access. The first two already existed
// (PATCH /generator/access/:token/draft, GET /generator/access/:token) — this
// covers the piece that was missing: GET /generator/member/agreements must
// actually return a usable resume token, not just status metadata, and must
// never leak one member's submission (or its token) to another member.

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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-agr-member-dash-'));
const port = 24700 + (process.pid % 300);
let nextUserId = 19500;
const jwt = require('jsonwebtoken');

function tokenFor(id, email, role) {
  return jwt.sign({ id, email, role }, process.env.JWT_SECRET);
}

async function makeUser(email, role = 'member') {
  const id = nextUserId++;
  await pool.query(
    `INSERT INTO users (id,email,password_hash,role) VALUES($1,$2,'x',$3) ON CONFLICT DO NOTHING`,
    [id, email, role]
  );
  return id;
}

async function req(method, urlPath, { token, body } = {}) {
  const response = await fetch(baseUrl + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const contentType = response.headers.get('content-type') || '';
  const parsed = contentType.includes('json') ? await response.json().catch(() => ({})) : await response.text();
  return { status: response.status, body: parsed };
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
  process.env.JWT_SECRET = 'agreement-member-dashboard-test-secret';
  process.env.NODE_ENV = 'test';
  process.env.SITE_URL = 'https://example.test';
  delete process.env.R2_ACCOUNT_ID;
  delete process.env.R2_ACCESS_KEY_ID;
  delete process.env.R2_SECRET_ACCESS_KEY;

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const migrations = fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations'))
    .filter((name) => name.endsWith('.sql')).sort();
  for (const file of migrations) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', file), 'utf8'));
  }

  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '512kb' }));
  app.use(attachUser);
  app.use('/agreement-forms', require('../src/middleware/agreementPaymentPolicy'));
  app.use('/agreement-forms', require('../src/routes/agreementForms').router);
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}, { timeout: 120000 });

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

let flow = {};

test('setup: an approved template exists to create a member-login submission from', async () => {
  const adminId = await makeUser('agr-memberdash-admin@test.com', 'admin');
  const adminToken = tokenFor(adminId, 'agr-memberdash-admin@test.com', 'admin');
  flow.adminToken = adminToken;

  const created = await req('POST', '/agreement-forms/generator/admin/templates', {
    token: adminToken,
    body: { name: 'Member Dashboard Resume Test', signerType: 'individual', accessMethod: 'member_login' },
  });
  assert.equal(created.status, 201);
  flow.templateId = created.body.form.id;

  const field = await req('POST', `/agreement-forms/generator/admin/templates/${flow.templateId}/fields`, {
    token: adminToken,
    body: { key: 'note', label: 'Note', kind: 'text', sectionKey: 'agreement_specific_questions', partyScope: 'agreement' },
  });
  assert.equal(field.status, 201, 'approval requires at least one field');

  await req('POST', `/agreement-forms/generator/admin/templates/${flow.templateId}/approval`, {
    token: adminToken, body: { status: 'legal_review', reason: 'Ready for review' },
  });
  const approved = await req('POST', `/agreement-forms/generator/admin/templates/${flow.templateId}/approval`, {
    token: adminToken, body: { status: 'approved', reason: 'Approved for test' },
  });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.template.approval_status, 'approved');
});

test('a member-login submission appears on the owning member\'s dashboard feed with a working resume token', async () => {
  const memberId = await makeUser('agr-memberdash-owner@test.com', 'member');
  const memberToken = tokenFor(memberId, 'agr-memberdash-owner@test.com', 'member');

  const created = await req('POST', '/agreement-forms/generator/admin/agreements', {
    token: flow.adminToken,
    body: { templateId: flow.templateId, partyBType: 'individual', accessMethod: 'member_login', memberUserId: memberId },
  });
  assert.equal(created.status, 201);
  const adminIssuedToken = new URL(created.body.secureLink).searchParams.get('token');
  assert.ok(adminIssuedToken, 'admin creation must still return a real secure link');

  const feed = await req('GET', '/agreement-forms/generator/member/agreements', { token: memberToken });
  assert.equal(feed.status, 200);
  assert.equal(feed.body.agreements.length, 1, 'the owning member must see exactly their own submission');
  const entry = feed.body.agreements[0];
  assert.equal(entry.workflow_status, 'draft');
  assert.equal(entry.signing_token, adminIssuedToken, 'the dashboard feed must return the SAME token the real resume link uses');

  // The token the dashboard returned must itself be a working resume link,
  // not just a plausible-looking value copied from the wrong column.
  const resumed = await req('GET', `/agreement-forms/generator/access/${entry.signing_token}`, { token: memberToken });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.agreement.reference, created.body.agreement.reference);

  // Saving a draft through that same token — the actual "continue where you
  // left off" action — must then be reflected back on the dashboard feed.
  const saved = await req('PATCH', `/agreement-forms/generator/access/${entry.signing_token}/draft`, {
    token: memberToken,
    body: { partyBType: 'individual', signerName: 'Dashboard Resume Test', answers: { note: 'in progress' } },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.status, 'in_progress');

  const feedAfter = await req('GET', '/agreement-forms/generator/member/agreements', { token: memberToken });
  assert.equal(feedAfter.body.agreements[0].workflow_status, 'in_progress');
  assert.equal(feedAfter.body.agreements[0].signing_token, entry.signing_token, 'the resume token must not change after a draft save');
});

test('a different member never sees another member\'s submission or its token', async () => {
  const otherMemberId = await makeUser('agr-memberdash-other@test.com', 'member');
  const otherToken = tokenFor(otherMemberId, 'agr-memberdash-other@test.com', 'member');
  const feed = await req('GET', '/agreement-forms/generator/member/agreements', { token: otherToken });
  assert.equal(feed.status, 200);
  assert.deepEqual(feed.body.agreements, []);
});

test('a private-link (not member-login) submission never appears on any member dashboard feed', async () => {
  const bystanderId = await makeUser('agr-memberdash-bystander@test.com', 'member');
  const bystanderToken = tokenFor(bystanderId, 'agr-memberdash-bystander@test.com', 'member');
  const created = await req('POST', '/agreement-forms/generator/admin/agreements', {
    token: flow.adminToken,
    body: { templateId: flow.templateId, partyBType: 'individual', accessMethod: 'private_link' },
  });
  assert.equal(created.status, 201);

  const feed = await req('GET', '/agreement-forms/generator/member/agreements', { token: bystanderToken });
  assert.equal(feed.status, 200);
  assert.deepEqual(feed.body.agreements, [], 'a private-link submission has no owning member and must not leak into anyone\'s feed');
});

test('the feed requires authentication', async () => {
  const { status } = await req('GET', '/agreement-forms/generator/member/agreements');
  assert.equal(status, 401);
});
