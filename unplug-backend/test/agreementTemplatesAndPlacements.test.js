// Agreement Forms: creating from a template, and the controlled public-page
// placement list — over real HTTP against real PostgreSQL.
//
// Both pieces of backend logic (template_id copy-through in POST /admin, and
// the public_pages column + GET /agreement-forms?page=X feed) already
// existed before this change but had no working path to them: "+ New
// agreement" never sent a templateId, and the placement field was free text
// with zero frontend pages ever consuming it. This pins the now-connected
// behavior: creating from a real seeded template copies its fields, and
// sanitizePages only ever keeps a page key a real button actually renders on
// (currently just 'checkout') — never an arbitrary string nothing consumes.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-agreement-templates-'));
const port = 22000 + (process.pid % 300);

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

let _nextUserId = 13000;
let _nextRef = 1;
const jwt = require('jsonwebtoken');
function tokenFor(id, email, role) {
  return jwt.sign({ id, email, role }, process.env.JWT_SECRET);
}
async function makeUser(email, role) {
  const id = _nextUserId++;
  await pool.query(`INSERT INTO users (id, email, password_hash, role) VALUES ($1,$2,'x',$3) ON CONFLICT DO NOTHING`, [id, email, role || 'admin']);
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
  process.env.JWT_SECRET = 'test-secret-for-agreement-templates';

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

// --- Templates -----------------------------------------------------------

test('GET /agreement-forms/admin/templates/list returns the seeded built-in templates with their fields', async () => {
  const adminId = await makeUser('admin-tpl@test.com', 'admin');
  const { status, body } = await req('GET', '/agreement-forms/admin/templates/list', { token: tokenFor(adminId, 'admin-tpl@test.com', 'admin') });
  assert.equal(status, 200);
  assert.ok(body.templates.length >= 8, 'the 8 built-in templates from 190_agreement_forms.sql should be seeded');
  const sponsorship = body.templates.find((t) => /sponsorship/i.test(t.name));
  assert.ok(sponsorship, 'the Sponsorship built-in template should exist');
  assert.ok(Array.isArray(sponsorship.fields));
});

test('POST /agreement-forms/admin with a real templateId copies the template\'s fields and metadata', async () => {
  const adminId = await makeUser('admin-tpl2@test.com', 'admin');
  const adminToken = tokenFor(adminId, 'admin-tpl2@test.com', 'admin');
  const list = await req('GET', '/agreement-forms/admin/templates/list', { token: adminToken });
  const template = list.body.templates.find((t) => /sponsorship/i.test(t.name));
  assert.ok(template, 'fixture assumption: a Sponsorship template exists');
  assert.ok(template.fields.length > 0, 'fixture assumption: the template has at least one field');

  const { status, body } = await req('POST', '/agreement-forms/admin', {
    token: adminToken,
    body: { name: 'From Template Test', title: 'From Template Test', templateId: template.id },
  });
  assert.equal(status, 201);
  assert.equal(body.agreement.template_id, template.id);
  assert.equal(body.fields.length, template.fields.length, 'every template field should have been copied onto the new agreement');
  assert.equal(body.fields[0].field_key, template.fields[0].field_key);
});

test('creating without a templateId still works exactly as before (blank agreement)', async () => {
  const adminId = await makeUser('admin-tpl3@test.com', 'admin');
  const { status, body } = await req('POST', '/agreement-forms/admin', {
    token: tokenFor(adminId, 'admin-tpl3@test.com', 'admin'),
    body: { name: 'Blank Agreement Test', title: 'Blank Agreement Test' },
  });
  assert.equal(status, 201);
  assert.equal(body.agreement.template_id, null);
  assert.deepEqual(body.fields, []);
});

// --- Controlled public-page placement -------------------------------------

test('sanitizePages only keeps a real, wired-up page key — never an arbitrary string', async () => {
  const adminId = await makeUser('admin-place@test.com', 'admin');
  const adminToken = tokenFor(adminId, 'admin-place@test.com', 'admin');
  const created = await req('POST', '/agreement-forms/admin', { token: adminToken, body: { name: 'Placement Test', title: 'Placement Test' } });
  const id = created.body.agreement.id;

  const patched = await req('PATCH', `/agreement-forms/admin/${id}`, {
    token: adminToken,
    body: { publicPages: ['checkout', 'homepage', 'made-up-page'] },
  });
  assert.equal(patched.status, 200);
  assert.deepEqual(patched.body.agreement.public_pages, ['checkout'], 'only the real, wired-up "checkout" key should survive — homepage and an arbitrary string are not consumed by any page yet, so they are dropped');
});

test('GET /agreement-forms?page=checkout only returns active, published agreements placed on checkout', async () => {
  const adminId = await makeUser('admin-place2@test.com', 'admin');
  const adminToken = tokenFor(adminId, 'admin-place2@test.com', 'admin');

  // Placed on checkout, but still draft+unpublished — must not appear.
  const draft = await req('POST', '/agreement-forms/admin', { token: adminToken, body: { name: 'Draft On Checkout', title: 'Draft On Checkout' } });
  await req('PATCH', `/agreement-forms/admin/${draft.body.agreement.id}`, { token: adminToken, body: { publicPages: ['checkout'], rules: 'x' } });

  // Active + published, but NOT placed on checkout — must not appear.
  const elsewhere = await req('POST', '/agreement-forms/admin', { token: adminToken, body: { name: 'Active Elsewhere', title: 'Active Elsewhere' } });
  await req('POST', `/agreement-forms/admin/${elsewhere.body.agreement.id}/fields`, { token: adminToken, body: { key: 'f', label: 'F', kind: 'text' } });
  await req('PATCH', `/agreement-forms/admin/${elsewhere.body.agreement.id}`, { token: adminToken, body: { rules: 'x', status: 'active', published: true } });

  // Active + published + placed on checkout — must appear.
  const live = await req('POST', '/agreement-forms/admin', { token: adminToken, body: { name: 'Live On Checkout', title: 'Live On Checkout' } });
  await req('POST', `/agreement-forms/admin/${live.body.agreement.id}/fields`, { token: adminToken, body: { key: 'f', label: 'F', kind: 'text' } });
  await req('PATCH', `/agreement-forms/admin/${live.body.agreement.id}`, { token: adminToken, body: { rules: 'x', status: 'active', published: true, publicPages: ['checkout'] } });

  const { status, body } = await req('GET', '/agreement-forms?page=checkout');
  assert.equal(status, 200);
  assert.equal(body.agreements.length, 1);
  assert.equal(body.agreements[0].title, 'Live On Checkout');
});

test('GET /agreement-forms with no ?page= returns an empty list, not everything', async () => {
  const { status, body } = await req('GET', '/agreement-forms');
  assert.equal(status, 200);
  assert.deepEqual(body.agreements, []);
});
