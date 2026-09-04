// Testimonials (TRUST-003) — real quotes only, from real directory members,
// advertisers and featured people. Deliberately modelled on Site Buttons
// and Popups: same "off until somebody switches it on" rule, same
// public/admin split, same cache header.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-testimonials-'));
const port = 64800 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

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
  process.env.JWT_SECRET = 'test-secret-for-testimonials';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const file of migrationFiles()) {
    await pool.query(fs.readFileSync(file, 'utf8'));
  }

  await pool.query(`INSERT INTO users (id, email, password_hash, role)
                    VALUES (991001, 'tstadmin@test.com', 'x', 'admin'),
                           (991002, 'tstmember@test.com', 'x', 'member')`);

  const jwt = require('jsonwebtoken');
  adminToken = jwt.sign({ id: 991001, email: 'tstadmin@test.com', role: 'admin' }, process.env.JWT_SECRET);
  memberToken = jwt.sign({ id: 991002, email: 'tstmember@test.com', role: 'member' }, process.env.JWT_SECRET);

  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/testimonials', require('../src/routes/testimonials'));
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

test('a member cannot list, create, edit or delete testimonials', async () => {
  assert.equal((await api('GET', '/testimonials/admin/all', null, memberToken)).status, 403);
  assert.equal((await api('POST', '/testimonials', { quote: 'x', authorName: 'x' }, memberToken)).status, 403);
  assert.equal((await api('PATCH', '/testimonials/1', { quote: 'x' }, memberToken)).status, 403);
  assert.equal((await api('DELETE', '/testimonials/1', null, memberToken)).status, 403);
});

test('a signed-out visitor cannot reach the admin routes', async () => {
  assert.equal((await api('GET', '/testimonials/admin/all')).status, 401);
  assert.equal((await api('POST', '/testimonials', { quote: 'x', authorName: 'x' })).status, 401);
});

// -------------------------------------------------------------------- create

test('A NEW TESTIMONIAL IS OFF BY DEFAULT — not live until an admin switches it on', async () => {
  const { status, body } = await api('POST', '/testimonials', { quote: 'Great platform.', authorName: 'A. Member' }, adminToken);
  assert.equal(status, 201);
  assert.equal(body.active, false);
});

test('QUOTE AND AUTHOR NAME ARE BOTH REQUIRED', async () => {
  assert.equal((await api('POST', '/testimonials', { authorName: 'x' }, adminToken)).status, 400);
  assert.equal((await api('POST', '/testimonials', { quote: 'x' }, adminToken)).status, 400);
});

// --------------------------------------------------------------- public feed

test('THE PUBLIC FEED ONLY RETURNS ACTIVE TESTIMONIALS, IN DISPLAY ORDER', async () => {
  const a = (await api('POST', '/testimonials', { quote: 'Second', authorName: 'Second Person', displayOrder: 2 }, adminToken)).body;
  const b = (await api('POST', '/testimonials', { quote: 'First', authorName: 'First Person', displayOrder: 1 }, adminToken)).body;
  const c = (await api('POST', '/testimonials', { quote: 'Never activated', authorName: 'Nobody', displayOrder: 0 }, adminToken)).body;
  await api('PATCH', `/testimonials/${a.id}`, { active: true }, adminToken);
  await api('PATCH', `/testimonials/${b.id}`, { active: true }, adminToken);

  const { status, body, headers } = await api('GET', '/testimonials');
  assert.equal(status, 200);
  const names = body.map((t) => t.author_name);
  assert.ok(!names.includes('Nobody'), 'an inactive testimonial must never appear in the public feed');
  assert.deepEqual(names.filter((n) => n === 'First Person' || n === 'Second Person'), ['First Person', 'Second Person']);
  assert.match(headers.get('cache-control') || '', /max-age=60/);
});

test('THE PUBLIC FEED NEVER HANDS OUT ADMIN-ONLY FIELDS', async () => {
  const created = (await api('POST', '/testimonials', { quote: 'Shape test', authorName: 'Shape Person' }, adminToken)).body;
  await api('PATCH', `/testimonials/${created.id}`, { active: true }, adminToken);
  const { body } = await api('GET', '/testimonials');
  const row = body.find((t) => t.author_name === 'Shape Person');
  assert.ok(row);
  assert.ok(!('created_by' in row));
  assert.ok(!('active' in row));
});

// ------------------------------------------------------------------- editing

test('EDITING A QUOTE OR NAME CANNOT BLANK IT OUT', async () => {
  const created = (await api('POST', '/testimonials', { quote: 'Editable', authorName: 'Ed Itable' }, adminToken)).body;
  assert.equal((await api('PATCH', `/testimonials/${created.id}`, { quote: '' }, adminToken)).status, 400);
  assert.equal((await api('PATCH', `/testimonials/${created.id}`, { authorName: '   ' }, adminToken)).status, 400);
});

test('TURNING A TESTIMONIAL OFF REMOVES IT FROM THE PUBLIC FEED IMMEDIATELY', async () => {
  const created = (await api('POST', '/testimonials', { quote: 'Toggle me', authorName: 'Toggler' }, adminToken)).body;
  await api('PATCH', `/testimonials/${created.id}`, { active: true }, adminToken);
  assert.ok((await api('GET', '/testimonials')).body.some((t) => t.author_name === 'Toggler'));
  await api('PATCH', `/testimonials/${created.id}`, { active: false }, adminToken);
  assert.ok(!(await api('GET', '/testimonials')).body.some((t) => t.author_name === 'Toggler'));
});

// ------------------------------------------------------------------- delete

test('DELETING A TESTIMONIAL REMOVES IT FROM BOTH THE ADMIN LIST AND THE PUBLIC FEED', async () => {
  const created = (await api('POST', '/testimonials', { quote: 'Delete me', authorName: 'Deleter' }, adminToken)).body;
  await api('PATCH', `/testimonials/${created.id}`, { active: true }, adminToken);
  const del = await api('DELETE', `/testimonials/${created.id}`, null, adminToken);
  assert.equal(del.status, 200);
  assert.ok(!(await api('GET', '/testimonials')).body.some((t) => t.author_name === 'Deleter'));
  const adminList = await api('GET', '/testimonials/admin/all', null, adminToken);
  assert.ok(!adminList.body.some((t) => t.author_name === 'Deleter'));
});

test('DELETING A TESTIMONIAL THAT DOES NOT EXIST IS A 404', async () => {
  assert.equal((await api('DELETE', '/testimonials/999999', null, adminToken)).status, 404);
});
