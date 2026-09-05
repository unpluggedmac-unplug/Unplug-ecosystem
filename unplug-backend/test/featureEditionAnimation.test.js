// Part 5 of "admin control over banner/cover animation effects": the
// homepage Feature Edition image — the one surface with no table row at all
// (a single CMS-swappable image), so its two values live in the existing
// generic settings key/value table, surfaced through /public-settings.
//
// Run with:  npm test   (from unplug-backend/)

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const jwt = require('jsonwebtoken');
const EmbeddedPostgres = require('embedded-postgres').default;
const { stopPostgres } = require('./helpers/stopPostgres');

let pg;
let pool;
let server;
let baseUrl;
let adminToken, memberToken;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-feanim-'));
const port = 61200 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

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

before(async () => {
  pg = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'postgres', password: 'postgres', port,
    persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('unplug_test');

  process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${port}/unplug_test`;
  process.env.JWT_SECRET = 'test-secret-for-feature-edition-animation';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }

  await pool.query(`INSERT INTO users (id, email, password_hash, role)
                    VALUES (1, 'admin@test.com', 'x', 'admin'), (2, 'member@test.com', 'x', 'member')
                    ON CONFLICT DO NOTHING`);
  adminToken = jwt.sign({ id: 1, email: 'admin@test.com', role: 'admin' }, process.env.JWT_SECRET);
  memberToken = jwt.sign({ id: 2, email: 'member@test.com', role: 'member' }, process.env.JWT_SECRET);

  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/admin', require('../src/routes/admin'));
  app.use('/public-settings', require('../src/routes/publicSettings'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}, { timeout: 120000 });

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('THE MIGRATION SEEDS BOTH KEYS, REPRODUCING TODAY\'S EXACT KEN BURNS PAN', async () => {
  const r = await pool.query(`SELECT key, value FROM settings WHERE key LIKE 'feature_edition_%' ORDER BY key`);
  assert.equal(r.rowCount, 2);
  const byKey = Object.fromEntries(r.rows.map((row) => [row.key, row.value]));
  assert.equal(byKey.feature_edition_animation_effect, 'zoom');
  assert.equal(byKey.feature_edition_transition_duration_ms, '24000');
});

test('GET /public-settings (UNAUTHENTICATED) RETURNS BOTH KEYS — the whitelist actually includes them', async () => {
  const r = await req('GET', '/public-settings');
  assert.equal(r.status, 200);
  assert.equal(r.body.settings.feature_edition_animation_effect, 'zoom');
  assert.equal(r.body.settings.feature_edition_transition_duration_ms, '24000');
});

test('A NON-ADMIN CANNOT CHANGE IT', async () => {
  const r = await req('PATCH', '/admin/settings/feature_edition_animation_effect', {
    token: memberToken, body: { value: 'fade' },
  });
  assert.equal(r.status, 403);
});

test('AN INVALID EFFECT IS A CLEAN 400', async () => {
  const r = await req('PATCH', '/admin/settings/feature_edition_animation_effect', {
    token: adminToken, body: { value: 'spin' },
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /feature_edition_animation_effect must be one of/);
});

test('A NON-POSITIVE DURATION IS A CLEAN 400', async () => {
  const r = await req('PATCH', '/admin/settings/feature_edition_transition_duration_ms', {
    token: adminToken, body: { value: '-5' },
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /feature_edition_transition_duration_ms must be a positive whole number/);
});

test('A VALID CHANGE STICKS AND IS IMMEDIATELY VISIBLE ON THE PUBLIC ROUTE', async () => {
  const r1 = await req('PATCH', '/admin/settings/feature_edition_animation_effect', {
    token: adminToken, body: { value: 'fade' },
  });
  assert.equal(r1.status, 200);
  const r2 = await req('PATCH', '/admin/settings/feature_edition_transition_duration_ms', {
    token: adminToken, body: { value: '600' },
  });
  assert.equal(r2.status, 200);

  const pub = await req('GET', '/public-settings');
  assert.equal(pub.body.settings.feature_edition_animation_effect, 'fade');
  assert.equal(pub.body.settings.feature_edition_transition_duration_ms, '600');
});
