// Analytics grouped by content type, over real HTTP against real PostgreSQL.
//
// page_views stores the SPA's own page names ('home', 'news') plus detail views
// as '<thing>-<id>' ('article-12', 'profile-jane-doe'). The categorisation is a
// mapping over those names, which is what lets it work on history already
// recorded rather than only on views collected from now on.
//
// The case that matters most: 'article-12' must land in Articles. If the exact
// -name lookup were checked before the prefixes, every detail view in the
// system would silently fall into "Other" and the whole screen would be wrong
// while still looking plausible.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-analytics-'));
const port = 8800 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

async function req(method, urlPath, { token } = {}) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, body: json };
}

// Records n views of a page, days ago, from distinct sessions.
async function view(pagePath, n, daysAgo = 0) {
  for (let i = 0; i < n; i++) {
    await pool.query(
      `INSERT INTO page_views (page_path, session_id, viewed_at)
       VALUES ($1, $2, now() - ($3::text || ' days')::interval)`,
      [pagePath, `sess-${pagePath}-${i}`, daysAgo]
    );
  }
}

const categoryNamed = (body, name) => body.categories.find((c) => c.category === name);

before(async () => {
  pg = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'postgres', password: 'postgres', port,
    persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('unplug_test');

  process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${port}/unplug_test`;
  process.env.JWT_SECRET = 'test-secret-for-analytics';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }

  const jwt = require('jsonwebtoken');
  adminToken = jwt.sign({ id: 1, email: 'admin@test.com', role: 'admin' }, process.env.JWT_SECRET);
  memberToken = jwt.sign({ id: 2, email: 'member@test.com', role: 'member' }, process.env.JWT_SECRET);

  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/analytics', require('../src/routes/analytics'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  // A representative spread: section pages, article details, profile details,
  // and something the mapping has never heard of.
  await view('home', 10);
  await view('news', 4);
  await view('article-12', 6);
  await view('article-13', 3);
  await view('directory', 2);
  await view('profile-jane-doe', 5);
  await view('profile-acme-co', 1);
  await view('top10', 7);
  await view('something-unmapped', 2);
  await view('editions', 4, 60); // outside the 30-day window
}, { timeout: 120000 });

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (pool) await pool.end();
  // stopPostgres, not pg.stop() directly: on Windows the library's stop
  // can HANG rather than throw, which used to leave the cluster running
  // with no parent and eventually broke a later test file's startup.
  // See test/helpers/stopPostgres.js.
  await stopPostgres(pg, dataDir);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('the breakdown is admin-only', async () => {
  assert.equal((await req('GET', '/analytics/by-category', { token: memberToken })).status, 403);
  assert.equal((await req('GET', '/analytics/by-category')).status, 401);
});

test('article detail views are counted as Articles, not Other', async () => {
  // The prefix rules must be checked before the exact-name lookup.
  const { body } = await req('GET', '/analytics/by-category', { token: adminToken });
  const articles = categoryNamed(body, 'Articles');
  assert.ok(articles, 'no Articles category was produced');
  assert.equal(articles.views, 13, 'expected news(4) + article-12(6) + article-13(3)');
});

test('profile detail views are counted as Directory', async () => {
  const { body } = await req('GET', '/analytics/by-category', { token: adminToken });
  const dir = categoryNamed(body, 'Directory');
  assert.equal(dir.views, 8, 'expected directory(2) + jane-doe(5) + acme-co(1)');
});

test('an unrecognised page falls into Other rather than being dropped', async () => {
  const { body } = await req('GET', '/analytics/by-category', { token: adminToken });
  const other = categoryNamed(body, 'Other');
  assert.ok(other, 'unmapped pages vanished from the totals');
  assert.equal(other.views, 2);
});

test('every view is accounted for — nothing is lost or double-counted', async () => {
  const { body } = await req('GET', '/analytics/by-category', { token: adminToken });
  const summed = body.categories.reduce((n, c) => n + c.views, 0);
  assert.equal(summed, body.totalViews, 'the categories do not add up to the total');
  assert.equal(body.totalViews, 40, 'home10+news4+a12:6+a13:3+dir2+jane5+acme1+top7+other2');
});

test('categories come back biggest first, with a percentage share', async () => {
  const { body } = await req('GET', '/analytics/by-category', { token: adminToken });
  const views = body.categories.map((c) => c.views);
  assert.deepEqual(views, [...views].sort((a, b) => b - a), 'categories are not ordered by size');

  const shares = body.categories.reduce((n, c) => n + c.share, 0);
  assert.ok(Math.abs(shares - 100) < 1.5, `shares should total ~100%, got ${shares}`);
});

test('each category names its busiest individual pages', async () => {
  // So "Directory did well" can be followed by "…because of these listings".
  const { body } = await req('GET', '/analytics/by-category', { token: adminToken });
  const dir = categoryNamed(body, 'Directory');
  assert.equal(dir.topPages[0].path, 'profile-jane-doe', 'top pages are not sorted by views');
  assert.ok(dir.topPages.length <= 5);
});

test('the range filter is honoured and only accepts known ranges', async () => {
  const thirty = await req('GET', '/analytics/by-category?range=30', { token: adminToken });
  assert.ok(!categoryNamed(thirty.body, 'Editions'), 'a 60-day-old view leaked into the 30-day window');

  const ninety = await req('GET', '/analytics/by-category?range=90', { token: adminToken });
  assert.equal(categoryNamed(ninety.body, 'Editions').views, 4);

  // Anything unexpected falls back to 30 rather than being interpolated.
  const junk = await req('GET', '/analytics/by-category?range=9999', { token: adminToken });
  assert.equal(junk.body.range, 30);
});
