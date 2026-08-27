// Unlisted pages, against a REAL PostgreSQL.
//
// What this protects:
//
//   1. THE LIST IS NOT SILENTLY TRUNCATED. settings.value was VARCHAR(255).
//      A long list would have been cut at the column, and the symptom would be
//      an admin unlisting a page, seeing no error, and finding it still in the
//      menu. That is why 146 widens the column, and why this test writes a
//      list far longer than 255 characters.
//   2. THE PUBLIC SITE CAN READ IT. It is the magazine that hides its own menu
//      entries, so the setting has to be on the public whitelist — and only
//      the whitelist, never the whole settings table.
//   3. A RE-RUN NEVER RESETS SOMEBODY'S CHOICE. Every migration here runs again
//      on every deploy; a seed without ON CONFLICT DO NOTHING would put the
//      menus back on a Tuesday for no visible reason.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-pagevis-'));
const port = 42000 + (process.pid % 300); // bases are 400 apart so ranges cannot overlap

const migrations = () => fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations'))
  .filter((x) => x.endsWith('.sql')).sort();

async function runMigrations() {
  for (const f of migrations()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }
}

async function api(method, urlPath, body, token) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
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
  process.env.JWT_SECRET = 'test-secret-for-pagevis';
  process.env.UNPLUG_DISABLE_RATE_LIMITS = '1';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await runMigrations();

  const jwt = require('jsonwebtoken');
  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/admin', require('../src/routes/admin'));
  app.use('/public-settings', require('../src/routes/publicSettings'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await pool.query(`INSERT INTO users (id, email, full_name, password_hash, role)
                    VALUES (550001, 'pvadmin@test.com', 'PV Admin', 'x', 'admin')`);
  adminToken = jwt.sign({ id: 550001, email: 'pvadmin@test.com', role: 'admin' }, process.env.JWT_SECRET);
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
});

const setting = async () => (await pool.query(
  `SELECT value FROM settings WHERE key = 'unlisted_pages'`)).rows[0].value;

test('the setting exists and starts empty — every page listed', async () => {
  assert.equal(await setting(), '');
});

test('THE PUBLIC SITE CAN READ IT', async () => {
  // The magazine hides its own menu entries, so it has to be able to see the
  // list. No login: this is read on every page load by every visitor.
  await api('PATCH', '/admin/settings/unlisted_pages', { value: 'nominate' }, adminToken);
  const res = await api('GET', '/public-settings');
  assert.equal(res.status, 200);
  assert.equal(res.body.settings.unlisted_pages, 'nominate');
});

test('and ONLY the whitelisted settings, never the whole table', async () => {
  const res = await api('GET', '/public-settings');
  // bundle_vote_price is a real setting and has no business being public.
  assert.equal(res.body.settings.bundle_vote_price, undefined);
  // The list is stated here ON PURPOSE, so adding a setting to the public
  // whitelist has to be a deliberate act in two places rather than something
  // that happens by accident in one. If this fails after you exposed a new
  // key, add it here — and think about whether it should be public first.
  const EXPECTED_PUBLIC = [
    'youtube_image_url',   // the admin-chosen YouTube image
    'unlisted_pages',      // the magazine hides its own menu entries
    'whatsapp_number',     // the assistant's "talk to a person" handoff
    'whatsapp_hours',
  ];
  assert.deepEqual(
    Object.keys(res.body.settings).filter((k) => !EXPECTED_PUBLIC.includes(k)),
    [], 'nothing outside the whitelist leaks');
});

test('A LONG LIST IS NOT SILENTLY TRUNCATED', async () => {
  // settings.value was VARCHAR(255). A list longer than that would have been
  // cut at the column with no error, and an admin would have unlisted a page
  // and watched it stay in the menu.
  const long = Array.from({ length: 40 }, (_, i) => 'a-fairly-long-page-id-' + i).join(',');
  assert.ok(long.length > 255, 'the fixture has to exceed the old column width');

  const res = await api('PATCH', '/admin/settings/unlisted_pages', { value: long }, adminToken);
  assert.equal(res.status, 200);
  assert.equal(await setting(), long, 'stored whole');
});

test('unlisting is admin-only', async () => {
  const res = await api('PATCH', '/admin/settings/unlisted_pages', { value: 'home' });
  assert.equal(res.status, 401);
});

test('A MIGRATION RE-RUN NEVER RESETS THE CHOICE', async () => {
  // Every migration here runs again on every deploy. A seed without
  // ON CONFLICT DO NOTHING would put the menus back on a Tuesday, silently.
  await api('PATCH', '/admin/settings/unlisted_pages', { value: 'nominate,gallery' }, adminToken);
  await runMigrations();
  assert.equal(await setting(), 'nominate,gallery');
});

test('re-running every migration is idempotent', async () => {
  await runMigrations();
  const r = await pool.query(
    `SELECT data_type FROM information_schema.columns
      WHERE table_name = 'settings' AND column_name = 'value'`);
  assert.equal(r.rows[0].data_type, 'text', 'the widening survives a re-run');
});

test('an empty list means nothing is hidden', async () => {
  await api('PATCH', '/admin/settings/unlisted_pages', { value: '' }, adminToken);
  const res = await api('GET', '/public-settings');
  assert.equal(res.body.settings.unlisted_pages, '');
});
