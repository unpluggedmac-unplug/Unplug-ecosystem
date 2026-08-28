// POST /articles/backfill-metadata.
//
// THIS ENDPOINT HAD NEVER ONCE WORKED. It returned 500 on its first row every
// time it was called:
//
//     suggested_category_id = COALESCE(suggested_category_id,
//       CASE WHEN category_id IS NULL THEN $6 ELSE NULL END)
//
// Postgres infers a bare $n from its surroundings, and inside a CASE whose
// other branch is NULL there is nothing to infer from — so it assumed text,
// and COALESCE(integer, text) is an error.
//
// Nothing had noticed because the "Fill in missing metadata" button in the
// admin dashboard was never wired to a handler, so the endpoint had no caller.
// Two separate defects hiding each other: a dead button in front of a broken
// endpoint. Found by auditing every admin button for a listener, then clicking
// the one that had none.
//
// Run with:  npm test   (from unplug-backend/)

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const EmbeddedPostgres = require('embedded-postgres').default;
const { stopPostgres } = require('./helpers/stopPostgres');
const { ensureStopWords } = require('./helpers/textSearch');

let pg;
let pool;
let server;
let baseUrl;
let adminToken;
let memberToken;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-backfill-'));
const port = 45600 + (process.pid % 300); // bases are 400 apart so ranges cannot overlap

const migrationsDir = path.join(__dirname, '..', 'db', 'migrations');
async function runMigrations() {
  for (const f of fs.readdirSync(migrationsDir).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(migrationsDir, f), 'utf8'));
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

const LONG = 'Every morning before six the ovens are already on and the queue starts at the gate. '
  + 'Thandi has run this bakery for nineteen years and knows most of the street by name, '
  + 'which is why the bread is spoken for before it has finished cooling.';

before(async () => {
  ensureStopWords();
  pg = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'postgres', password: 'postgres', port,
    persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('unplug_test');

  process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${port}/unplug_test`;
  process.env.JWT_SECRET = 'test-secret-for-backfill';
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
  app.use('/articles', require('../src/routes/articles'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await pool.query(`INSERT INTO users (id, email, full_name, password_hash, role) VALUES
    (620001, 'bfadmin@test.com', 'BF Admin', 'x', 'admin'),
    (620002, 'bfmember@test.com', 'BF Member', 'x', 'member')`);
  adminToken = jwt.sign({ id: 620001, email: 'bfadmin@test.com', role: 'admin' }, process.env.JWT_SECRET);
  memberToken = jwt.sign({ id: 620002, email: 'bfmember@test.com', role: 'member' }, process.env.JWT_SECRET);

  await pool.query(`INSERT INTO categories (id, name, type) VALUES (9601, 'Community', 'news')
                    ON CONFLICT (id) DO NOTHING`);
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
});

const bare = (id, title, categoryId) => pool.query(
  `INSERT INTO articles (id, author_user_id, category_id, title, body, status, published_at)
   VALUES ($1, 620002, $2, $3, $4, 'approved', now())`, [id, categoryId, title, LONG]);

// ---------------------------------------------------------------------------

test('IT RUNS AT ALL — this returned 500 every time it was ever called', async () => {
  await bare(9611, 'A bakery on Vilakazi Street', 9601);
  const { status, body } = await api('POST', '/articles/backfill-metadata', null, adminToken);
  assert.equal(status, 200, 'a 500 here is the original bug: COALESCE(integer, text)');
  assert.ok(body.processed >= 1);
  assert.match(body.message, /Filled in metadata/);
});

test('THE ROW WITH NO CATEGORY IS THE ONE THAT BROKE IT', async () => {
  // suggested_category_id is only written when category_id IS NULL, so an
  // article without a category is the only path that reaches the CASE
  // expression whose parameter had no inferable type.
  await bare(9612, 'The bicycle man of Khayelitsha', null);
  const { status, body } = await api('POST', '/articles/backfill-metadata', null, adminToken);
  assert.equal(status, 200);
  assert.ok(body.processed >= 1);

  const row = await pool.query('SELECT category_id, suggested_category_id, slug FROM articles WHERE id = 9612');
  assert.equal(row.rows[0].category_id, null);
  assert.ok(row.rows[0].slug, 'and it still got its slug');
});

test('it fills the fields that were empty', async () => {
  const row = await pool.query(
    'SELECT slug, meta_description, key_takeaways, keywords, seo_title FROM articles WHERE id = 9611');
  const a = row.rows[0];
  assert.equal(a.slug, 'a-bakery-on-vilakazi-street');
  assert.ok(a.meta_description && a.meta_description.length > 20);
  assert.ok(Array.isArray(a.key_takeaways) && a.key_takeaways.length);
  assert.ok(Array.isArray(a.keywords) && a.keywords.length);
  assert.equal(a.seo_title, 'A bakery on Vilakazi Street');
});

test("AN EDITOR'S OWN WORDING IS NEVER OVERWRITTEN", async () => {
  await bare(9613, 'A story with its own summary', 9601);
  await pool.query(
    `UPDATE articles SET meta_description = 'Written by a person, not derived.' WHERE id = 9613`);
  await api('POST', '/articles/backfill-metadata', null, adminToken);
  const row = await pool.query('SELECT meta_description FROM articles WHERE id = 9613');
  assert.equal(row.rows[0].meta_description, 'Written by a person, not derived.');
});

test('running it again is safe and says there is nothing to do', async () => {
  const { status, body } = await api('POST', '/articles/backfill-metadata', null, adminToken);
  assert.equal(status, 200);
  assert.equal(body.processed, 0);
  assert.match(body.message, /already has its metadata/i);
});

test('slugs stay unique', async () => {
  await bare(9614, 'A bakery on Vilakazi Street', 9601);   // same title as 9611
  await api('POST', '/articles/backfill-metadata', null, adminToken);
  const rows = await pool.query('SELECT slug FROM articles WHERE id IN (9611, 9614)');
  const slugs = rows.rows.map((r) => r.slug);
  assert.equal(new Set(slugs).size, 2, 'two articles, two different slugs');
});

test('it is admin-only', async () => {
  assert.equal((await api('POST', '/articles/backfill-metadata', null, memberToken)).status, 403);
  assert.equal((await api('POST', '/articles/backfill-metadata')).status, 401);
});
