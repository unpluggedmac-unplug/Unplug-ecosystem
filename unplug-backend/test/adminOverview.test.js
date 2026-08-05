// GET /admin/overview — the Dashboard Overview screen, over real HTTP against
// real PostgreSQL.
//
// This endpoint aggregates counts from a dozen different tables
// (profile_claims, profile_reviews, article_comments, gallery_images, ...),
// several of which have names that don't match their public-facing concept
// ("reviews" -> profile_reviews, gallery photos have no title column, only
// caption). A syntax check cannot catch a wrong table or column name — only
// running the actual query against a real schema can, which is the entire
// reason this test exists rather than just reading the code.
//
// Run with:  npm test   (from unplug-backend/)

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const EmbeddedPostgres = require('embedded-postgres').default;

let pg;
let pool;
let server;
let baseUrl;
let adminToken;
let memberToken;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-overview-'));
const port = 9200 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

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
  process.env.JWT_SECRET = 'test-secret-for-overview';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }

  const jwt = require('jsonwebtoken');
  adminToken = jwt.sign({ id: 1, email: 'admin@test.com', role: 'admin' }, process.env.JWT_SECRET);
  memberToken = jwt.sign({ id: 2, email: 'member@test.com', role: 'member' }, process.env.JWT_SECRET);
  await pool.query(`INSERT INTO users (id, email, password_hash, role)
                    VALUES (1, 'admin@test.com', 'x', 'admin'),
                           (2, 'member@test.com', 'x', 'member'),
                           (3, 'member2@test.com', 'x', 'member')
                    ON CONFLICT DO NOTHING`);

  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/admin', require('../src/routes/admin'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  // A small amount of real data across the tables the endpoint aggregates,
  // so a wrong table/column name produces a wrong COUNT rather than a
  // coincidentally-correct zero.
  await pool.query(`INSERT INTO articles (title, slug, body, status, author_user_id)
                    VALUES ('Approved One', 'approved-one', 'x', 'approved', 2),
                           ('Pending One', 'pending-one', 'x', 'pending', 2)`);
  await pool.query(`INSERT INTO profiles (user_id, display_name, slug, package_tier, status)
                    VALUES (2, 'Approved Profile', 'approved-profile', 'basic', 'approved'),
                           (3, 'Pending Profile', 'pending-profile', 'basic', 'pending')`);
  await pool.query(`INSERT INTO gallery_images (owner_type, image_url, caption, status)
                    VALUES ('general', 'https://x/1.jpg', 'A photo', 'approved'),
                           ('general', 'https://x/2.jpg', NULL, 'pending')`);
  await pool.query(`INSERT INTO profile_claims (profile_id, user_id, status)
                    VALUES (1, 2, 'pending')`);
  await pool.query(`INSERT INTO profile_reviews (profile_id, user_id, rating, status)
                    VALUES (1, 2, 5, 'pending')`);
  await pool.query(`INSERT INTO article_comments (article_id, user_id, body, status)
                    VALUES (1, 2, 'nice piece', 'pending')`);
  await pool.query(`INSERT INTO payments (user_id, amount, method, gateway_reference, linked_type, linked_id, status)
                    VALUES (2, 95.00, 'eft', 'OVERVIEWREF1', 'article_publish', 1, 'pending')`);
}, { timeout: 120000 });

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (pool) await pool.end();
  if (pg) await pg.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('the overview is admin-only', async () => {
  assert.equal((await req('GET', '/admin/overview', { token: memberToken })).status, 403);
  assert.equal((await req('GET', '/admin/overview')).status, 401);
});

test('totals count only approved/published content, per type', async () => {
  const { status, body } = await req('GET', '/admin/overview', { token: adminToken });
  assert.equal(status, 200);
  assert.equal(body.totals.users, 3);
  assert.equal(body.totals.articles, 1, 'a pending article was counted as published');
  assert.equal(body.totals.profiles, 1, 'a pending profile was counted as approved');
  assert.equal(body.totals.gallery, 1, 'a pending photo was counted as approved');
});

test('pending counts read the real tables — profile_claims, profile_reviews, article_comments', async () => {
  // This is the assertion that would have caught the wrong table names
  // ('listing_claims', 'reviews', 'comments') before they ever reached a
  // deploy: those queries would either 500 outright or (worse) silently
  // return 0 forever because the tables simply don't exist.
  const { body } = await req('GET', '/admin/overview', { token: adminToken });
  assert.equal(body.pending.articles, 1);
  assert.equal(body.pending.profiles, 1);
  assert.equal(body.pending.gallery, 1);
  assert.equal(body.pending.claims, 1);
  assert.equal(body.pending.reviews, 1);
  assert.equal(body.pending.comments, 1);
  assert.equal(body.pending.total, 6, 'the total does not sum the individual pending counts');
});

test('the pending EFT amount is a real number, not a string', async () => {
  const { body } = await req('GET', '/admin/overview', { token: adminToken });
  assert.equal(body.payments.pendingEftCount, 1);
  assert.equal(body.payments.pendingEftAmount, 95, 'NUMERIC came back as a string and was not cast');
  assert.equal(typeof body.payments.pendingEftAmount, 'number');
});

test('recent submissions include gallery photos with no caption, without breaking', async () => {
  // caption is nullable; a photo with none must still appear with a label
  // rather than crashing the UNION or showing "null".
  const { body } = await req('GET', '/admin/overview', { token: adminToken });
  const uncaptioned = body.recentSubmissions.find((r) => r.kind === 'gallery' && r.label !== 'A photo');
  assert.ok(uncaptioned, 'the uncaptioned photo is missing from recent submissions');
  assert.equal(uncaptioned.label, 'Untitled photo');
});

test('recent submissions are capped and sorted newest first', async () => {
  const { body } = await req('GET', '/admin/overview', { token: adminToken });
  assert.ok(body.recentSubmissions.length <= 10);
  const dates = body.recentSubmissions.map((r) => new Date(r.created_at).getTime());
  assert.deepEqual(dates, [...dates].sort((a, b) => b - a), 'recent submissions are not newest-first');
});
