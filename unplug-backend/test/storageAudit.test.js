// N-3: two Supabase projects exist — production (jaywxegcxjgyqhcwzbte) and
// an older, retired one (fkuzbwysvyskhsskjmmi) some stored URLs still
// point at. Grepping the whole codebase found the old project ref
// hardcoded nowhere — migrations, routes, HTML, .env.example, all clean —
// so any stale URL only exists as data someone typed into an admin field
// at some point (e.g. a site-settings image), and only live database
// access can see it, which this session's local test harness cannot
// substitute for. This endpoint IS that access: an on-demand, admin-only
// scan of every URL-shaped column in the real database.
//
// Rather than hand-list every *_url column (there are dozens, across
// dozens of tables, and a hand-built list goes stale the moment a new one
// is added), the columns checked are discovered from the database's own
// catalog at request time.
//
// Website remediation punch-list (2026-09-03), N-3.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-storageaudit-'));
const port = 65200 + (process.pid % 299); // unique per test file: bases are 400 apart so the offset ranges cannot overlap (kept well under the 65535 TCP port ceiling)

function migrationFiles() {
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
    .map((f) => path.join(dir, f));
}

async function req(method, urlPath, { token } = {}) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}) },
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
  process.env.JWT_SECRET = 'test-secret-for-storageaudit';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const file of migrationFiles()) {
    await pool.query(fs.readFileSync(file, 'utf8'));
  }

  const jwt = require('jsonwebtoken');
  await pool.query(`INSERT INTO users (id, email, password_hash, role)
                    VALUES (992001, 'saadmin@test.com', 'x', 'admin'),
                           (992002, 'samember@test.com', 'x', 'member')`);
  adminToken = jwt.sign({ id: 992001, email: 'saadmin@test.com', role: 'admin' }, process.env.JWT_SECRET);
  memberToken = jwt.sign({ id: 992002, email: 'samember@test.com', role: 'member' }, process.env.JWT_SECRET);

  // A real stale value, planted directly — this is exactly the shape of
  // thing a live production database could hold (an admin-set image URL
  // that predates the storage consolidation).
  await pool.query(
    `UPDATE settings SET value = 'https://fkuzbwysvyskhsskjmmi.supabase.co/storage/v1/object/public/site/youtube.jpg'
      WHERE key = 'youtube_image_url'`
  );
  // A clean row, to prove the scan does not just flag everything.
  await pool.query(
    `INSERT INTO profiles (user_id, type, package_tier, slug, display_name, status, feature_image_url)
     VALUES (992002, 'individual', 'basic', 'sa-test-profile', 'Storage Audit Test', 'approved',
             'https://jaywxegcxjgyqhcwzbte.supabase.co/storage/v1/object/public/site/clean.jpg')`
  );

  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/admin', require('../src/routes/admin'));
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

test('a member cannot run the storage audit', async () => {
  assert.equal((await req('GET', '/admin/storage-audit', { token: memberToken })).status, 403);
});

test('a signed-out visitor cannot run the storage audit', async () => {
  assert.equal((await req('GET', '/admin/storage-audit')).status, 401);
});

test('THE AUDIT FINDS THE REAL STALE SETTING, AND NAMES THE TABLE/COLUMN/ROW IT LIVES IN', async () => {
  const { status, body } = await req('GET', '/admin/storage-audit', { token: adminToken });
  assert.equal(status, 200);
  const hit = body.findings.find((f) => f.table === 'settings' && f.rowId === 'youtube_image_url');
  assert.ok(hit, 'the stale youtube_image_url setting should be found');
  assert.match(hit.value, /fkuzbwysvyskhsskjmmi/);
});

test('A CLEAN URL POINTING AT THE PRODUCTION PROJECT IS NEVER FLAGGED', async () => {
  const { body } = await req('GET', '/admin/storage-audit', { token: adminToken });
  const falsePositive = body.findings.find((f) => f.table === 'profiles' && f.column === 'feature_image_url');
  assert.ok(!falsePositive, 'a URL on the real production project must not be flagged as stale');
});

test('THE SEARCHED HOST CAN BE OVERRIDDEN VIA A QUERY PARAM', async () => {
  const { body } = await req('GET', '/admin/storage-audit?host=jaywxegcxjgyqhcwzbte', { token: adminToken });
  assert.equal(body.searchedHost, 'jaywxegcxjgyqhcwzbte');
  // Searching for the PRODUCTION host now finds the "clean" profile row
  // instead — proving the search term actually drives the query rather
  // than always looking for the same hardcoded string.
  const hit = body.findings.find((f) => f.table === 'profiles' && f.column === 'feature_image_url');
  assert.ok(hit);
});

test('THE COLUMN DISCOVERY IS REAL — MANY URL-SHAPED COLUMNS ARE CHECKED, NOT A SHORT HAND-PICKED LIST', async () => {
  const { body } = await req('GET', '/admin/storage-audit', { token: adminToken });
  assert.ok(body.columnsChecked > 20, `expected dozens of URL-shaped columns to be discovered, got ${body.columnsChecked}`);
});
