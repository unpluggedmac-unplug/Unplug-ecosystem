// Agreement Forms: admin-controlled button label — over real HTTP against
// real PostgreSQL.
//
// The public/member feeds previously always rendered the same fixed button
// text regardless of the agreement, which read oddly for something like a
// sponsorship deal ("View & sign agreement" instead of, say, "Sponsor Our
// Homepage"). This pins that an admin can set it per agreement, that it
// flows through both feeds that render a signing button, and that leaving it
// blank keeps the old fixed text as a fallback rather than showing nothing.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-agreement-button-label-'));
const port = 23000 + (process.pid % 300);

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

let _nextUserId = 14000;
const jwt = require('jsonwebtoken');
function tokenFor(id, email, role) {
  return jwt.sign({ id, email, role }, process.env.JWT_SECRET);
}
async function makeUser(email, role) {
  const id = _nextUserId++;
  await pool.query(`INSERT INTO users (id, email, password_hash, role) VALUES ($1,$2,'x',$3) ON CONFLICT DO NOTHING`, [id, email, role || 'admin']);
  return id;
}
async function makeActiveAgreement(adminToken, overrides = {}) {
  const created = await req('POST', '/agreement-forms/admin', {
    token: adminToken,
    body: { name: overrides.name || `Agreement ${Date.now()}-${Math.random()}`, title: overrides.title || 'Title' },
  });
  const id = created.body.agreement.id;
  await req('POST', `/agreement-forms/admin/${id}/fields`, { token: adminToken, body: { key: 'f', label: 'F', kind: 'text' } });
  await req('PATCH', `/agreement-forms/admin/${id}`, {
    token: adminToken,
    body: { rules: 'x', status: 'active', published: true, publicPages: ['checkout'], memberVisible: true, ...overrides },
  });
  return id;
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
  process.env.JWT_SECRET = 'test-secret-for-agreement-button-label';

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
  app.use('/agreement-forms', require('../src/routes/agreementForms').router);
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

test('an admin-set button label is returned by the public page feed', async () => {
  const adminId = await makeUser('admin-btn1@test.com', 'admin');
  const adminToken = tokenFor(adminId, 'admin-btn1@test.com', 'admin');
  await makeActiveAgreement(adminToken, { name: 'Sponsor Test', title: 'Sponsor Test', buttonLabel: 'Sponsor Our Homepage' });

  const { status, body } = await req('GET', '/agreement-forms?page=checkout');
  assert.equal(status, 200);
  const found = body.agreements.find((a) => a.title === 'Sponsor Test');
  assert.ok(found);
  assert.equal(found.button_label, 'Sponsor Our Homepage');
});

test('an admin-set button label is returned by the member-dashboard feed too', async () => {
  const adminId = await makeUser('admin-btn2@test.com', 'admin');
  const memberId = await makeUser('member-btn2@test.com', 'member');
  const adminToken = tokenFor(adminId, 'admin-btn2@test.com', 'admin');
  await makeActiveAgreement(adminToken, { name: 'Member Test', title: 'Member Test', buttonLabel: 'Join the Directory' });

  const { status, body } = await req('GET', '/agreement-forms/member', { token: tokenFor(memberId, 'member-btn2@test.com', 'member') });
  assert.equal(status, 200);
  const found = body.agreements.find((a) => a.title === 'Member Test');
  assert.ok(found);
  assert.equal(found.button_label, 'Join the Directory');
});

test('leaving the button label blank returns null, not an empty string', async () => {
  const adminId = await makeUser('admin-btn3@test.com', 'admin');
  const adminToken = tokenFor(adminId, 'admin-btn3@test.com', 'admin');
  await makeActiveAgreement(adminToken, { name: 'No Label Test', title: 'No Label Test' });

  const { body } = await req('GET', '/agreement-forms?page=checkout');
  const found = body.agreements.find((a) => a.title === 'No Label Test');
  assert.ok(found);
  assert.equal(found.button_label, null);
});

test('the button label can be set, then cleared back to blank', async () => {
  const adminId = await makeUser('admin-btn4@test.com', 'admin');
  const adminToken = tokenFor(adminId, 'admin-btn4@test.com', 'admin');
  const id = await makeActiveAgreement(adminToken, { name: 'Clear Test', title: 'Clear Test', buttonLabel: 'Something' });

  const cleared = await req('PATCH', `/agreement-forms/admin/${id}`, { token: adminToken, body: { buttonLabel: '' } });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.agreement.button_label, null);
});
