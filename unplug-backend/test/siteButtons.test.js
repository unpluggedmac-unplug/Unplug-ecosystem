// Site Buttons — a small, always-on-screen floating stack of admin-managed
// CTA buttons (icon + label + link) on every public page. Requested
// separately from the visitor-experience punch-list: admin wanted a way to
// add several such buttons without a code change each time.
//
// Deliberately modelled on Popups (same "off until somebody switches it on"
// rule, same public/admin split, same cache header) but simpler: no
// scheduling, no frequency capping, no page targeting — a floating button is
// meant to always be reachable, not to interrupt and go away.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-sitebuttons-'));
const port = 62400 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

function migrationFiles() {
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
    .map((f) => path.join(dir, f));
}

async function api(method, urlPath, body, token) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
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
  process.env.JWT_SECRET = 'test-secret-for-sitebuttons';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const file of migrationFiles()) {
    await pool.query(fs.readFileSync(file, 'utf8'));
  }

  await pool.query(`INSERT INTO users (id, email, full_name, password_hash, role)
                    VALUES (990001, 'sbadmin@test.com', 'SB Admin', 'x', 'admin'),
                           (990002, 'sbmember@test.com', 'SB Member', 'x', 'member')`);

  const jwt = require('jsonwebtoken');
  adminToken = jwt.sign({ id: 990001, email: 'sbadmin@test.com', role: 'admin' }, process.env.JWT_SECRET);
  memberToken = jwt.sign({ id: 990002, email: 'sbmember@test.com', role: 'member' }, process.env.JWT_SECRET);

  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/site-buttons', require('../src/routes/siteButtons'));
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

// ---------------------------------------------------------------- permissions

test('a member cannot list, create, edit or delete site buttons', async () => {
  assert.equal((await api('GET', '/site-buttons/admin/all', null, memberToken)).status, 403);
  assert.equal((await api('POST', '/site-buttons', { label: 'x', url: 'https://x.com' }, memberToken)).status, 403);
  assert.equal((await api('PATCH', '/site-buttons/1', { label: 'x' }, memberToken)).status, 403);
  assert.equal((await api('DELETE', '/site-buttons/1', null, memberToken)).status, 403);
});

test('a signed-out visitor cannot reach the admin routes', async () => {
  assert.equal((await api('GET', '/site-buttons/admin/all')).status, 401);
  assert.equal((await api('POST', '/site-buttons', { label: 'x', url: 'https://x.com' })).status, 401);
});

// -------------------------------------------------------------------- create

test('A NEW BUTTON IS OFF BY DEFAULT — the same "not live until somebody says so" rule Popups follow', async () => {
  const { status, body } = await api('POST', '/site-buttons', { label: 'Chat', url: 'https://wa.me/123' }, adminToken);
  assert.equal(status, 201);
  assert.equal(body.active, false);
});

test('LABEL AND LINK ARE BOTH REQUIRED', async () => {
  assert.equal((await api('POST', '/site-buttons', { url: 'https://x.com' }, adminToken)).status, 400);
  assert.equal((await api('POST', '/site-buttons', { label: 'x' }, adminToken)).status, 400);
});

// --------------------------------------------------------------- public feed

test('THE PUBLIC FEED ONLY RETURNS ACTIVE BUTTONS, IN DISPLAY ORDER', async () => {
  const a = (await api('POST', '/site-buttons', { label: 'Second', url: 'https://b.com', displayOrder: 2 }, adminToken)).body;
  const b = (await api('POST', '/site-buttons', { label: 'First', url: 'https://a.com', displayOrder: 1 }, adminToken)).body;
  const c = (await api('POST', '/site-buttons', { label: 'Never activated', url: 'https://c.com', displayOrder: 0 }, adminToken)).body;
  await api('PATCH', `/site-buttons/${a.id}`, { active: true }, adminToken);
  await api('PATCH', `/site-buttons/${b.id}`, { active: true }, adminToken);
  // c stays off deliberately.

  const { status, body, headers } = await api('GET', '/site-buttons');
  assert.equal(status, 200);
  const labels = body.map((btn) => btn.label);
  assert.ok(!labels.includes('Never activated'), 'an inactive button must never appear in the public feed');
  assert.deepEqual(labels.filter((l) => l === 'First' || l === 'Second'), ['First', 'Second'],
    'active buttons must come back in display_order, not creation order');
  assert.match(headers.get('cache-control') || '', /max-age=60/, 'the public feed should be cacheable, like Popups');
});

test('THE PUBLIC FEED NEVER HANDS OUT ADMIN-ONLY FIELDS', async () => {
  const created = (await api('POST', '/site-buttons', { label: 'Public shape test', url: 'https://x.com' }, adminToken)).body;
  await api('PATCH', `/site-buttons/${created.id}`, { active: true }, adminToken);
  const { body } = await api('GET', '/site-buttons');
  const row = body.find((b) => b.label === 'Public shape test');
  assert.ok(row);
  assert.ok(!('created_by' in row), 'created_by should not be exposed publicly');
  assert.ok(!('active' in row), 'a public row need not even carry active — everything returned here already is');
});

// ------------------------------------------------------------------- editing

test('EDITING A LABEL OR LINK CANNOT BLANK IT OUT', async () => {
  const created = (await api('POST', '/site-buttons', { label: 'Editable', url: 'https://x.com' }, adminToken)).body;
  assert.equal((await api('PATCH', `/site-buttons/${created.id}`, { label: '' }, adminToken)).status, 400);
  assert.equal((await api('PATCH', `/site-buttons/${created.id}`, { url: '   ' }, adminToken)).status, 400);
});

test('TURNING A BUTTON OFF REMOVES IT FROM THE PUBLIC FEED IMMEDIATELY', async () => {
  const created = (await api('POST', '/site-buttons', { label: 'Toggle me', url: 'https://x.com' }, adminToken)).body;
  await api('PATCH', `/site-buttons/${created.id}`, { active: true }, adminToken);
  assert.ok((await api('GET', '/site-buttons')).body.some((b) => b.label === 'Toggle me'));
  await api('PATCH', `/site-buttons/${created.id}`, { active: false }, adminToken);
  assert.ok(!(await api('GET', '/site-buttons')).body.some((b) => b.label === 'Toggle me'));
});

// ------------------------------------------------------------------- delete

test('DELETING A BUTTON REMOVES IT FROM BOTH THE ADMIN LIST AND THE PUBLIC FEED', async () => {
  const created = (await api('POST', '/site-buttons', { label: 'Delete me', url: 'https://x.com' }, adminToken)).body;
  await api('PATCH', `/site-buttons/${created.id}`, { active: true }, adminToken);
  const del = await api('DELETE', `/site-buttons/${created.id}`, null, adminToken);
  assert.equal(del.status, 200);
  assert.ok(!(await api('GET', '/site-buttons')).body.some((b) => b.label === 'Delete me'));
  const adminList = await api('GET', '/site-buttons/admin/all', null, adminToken);
  assert.ok(!adminList.body.some((b) => b.label === 'Delete me'));
});

test('DELETING A BUTTON THAT DOES NOT EXIST IS A 404', async () => {
  assert.equal((await api('DELETE', '/site-buttons/999999', null, adminToken)).status, 404);
});
