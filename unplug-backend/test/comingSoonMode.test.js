// Coming Soon mode, against a REAL PostgreSQL.
//
// What this protects:
//
//   1. OFF BY DEFAULT. A fresh install (or a migration re-run — every
//      migration here runs again on every deploy) must never put a live site
//      into Coming Soon mode on its own.
//   2. THE PUBLIC SITE CAN READ IT, AND ONLY THE WHITELISTED KEYS. The
//      magazine polls this with no login on every page load, so it has to be
//      on the public whitelist — but nothing else in `settings` should ride
//      along with it.
//   3. TOGGLING IT IS ADMIN-ONLY.
//   4. A MIGRATION RE-RUN NEVER RESETS AN ADMIN'S CHOICE (heading, message,
//      or having switched it on).
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-comingsoon-'));
const port = 46800 + (process.pid % 300); // bases are 400 apart so ranges cannot overlap

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
  process.env.JWT_SECRET = 'test-secret-for-comingsoon';
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
                    VALUES (550002, 'csadmin@test.com', 'CS Admin', 'x', 'admin')`);
  adminToken = jwt.sign({ id: 550002, email: 'csadmin@test.com', role: 'admin' }, process.env.JWT_SECRET);
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
});

const setting = async (key) => (await pool.query(
  `SELECT value FROM settings WHERE key = $1`, [key])).rows[0].value;

test('off by default, with a real heading and message already seeded', async () => {
  assert.equal(await setting('coming_soon_active'), 'false');
  assert.ok((await setting('coming_soon_heading')).length > 0);
  assert.ok((await setting('coming_soon_message')).length > 0);
});

test('THE PUBLIC SITE CAN READ ALL THREE, WITH NO LOGIN', async () => {
  const res = await api('GET', '/public-settings');
  assert.equal(res.status, 200);
  assert.equal(res.body.settings.coming_soon_active, 'false');
  assert.equal(typeof res.body.settings.coming_soon_heading, 'string');
  assert.equal(typeof res.body.settings.coming_soon_message, 'string');
});

test('turning it on is admin-only', async () => {
  const res = await api('PATCH', '/admin/settings/coming_soon_active', { value: 'true' });
  assert.equal(res.status, 401);
  assert.equal(await setting('coming_soon_active'), 'false', 'refused, so nothing changed');
});

test('an admin can turn it on, with a custom heading and message, and the public sees it', async () => {
  await api('PATCH', '/admin/settings/coming_soon_active', { value: 'true' }, adminToken);
  await api('PATCH', '/admin/settings/coming_soon_heading', { value: 'Back soon' }, adminToken);
  await api('PATCH', '/admin/settings/coming_soon_message', { value: 'Doing some upgrades.' }, adminToken);

  const res = await api('GET', '/public-settings');
  assert.equal(res.body.settings.coming_soon_active, 'true');
  assert.equal(res.body.settings.coming_soon_heading, 'Back soon');
  assert.equal(res.body.settings.coming_soon_message, 'Doing some upgrades.');
});

test('and only the whitelisted keys ever come back, never the whole settings table', async () => {
  const res = await api('GET', '/public-settings');
  // bundle_vote_price is a real setting and has no business being public.
  assert.equal(res.body.settings.bundle_vote_price, undefined);
});

test('an admin can turn it back off', async () => {
  await api('PATCH', '/admin/settings/coming_soon_active', { value: 'false' }, adminToken);
  assert.equal(await setting('coming_soon_active'), 'false');
});

test('A MIGRATION RE-RUN NEVER RESETS THE CHOICE', async () => {
  // Every migration here runs again on every deploy. A seed without
  // ON CONFLICT DO NOTHING would silently switch a live site's Coming Soon
  // mode (or its custom heading/message) back to the default on a Tuesday.
  await api('PATCH', '/admin/settings/coming_soon_active', { value: 'true' }, adminToken);
  await api('PATCH', '/admin/settings/coming_soon_heading', { value: 'Still upgrading' }, adminToken);
  await runMigrations();
  assert.equal(await setting('coming_soon_active'), 'true');
  assert.equal(await setting('coming_soon_heading'), 'Still upgrading');
});
