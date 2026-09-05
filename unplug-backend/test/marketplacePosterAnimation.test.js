// Part 2 of "admin control over banner/cover animation effects": per-listing
// entrance effect, transition speed, and how long a poster stays up before
// the Marketplace carousel advances — the same mechanism Ad Banners already
// got (adBannerAnimation.test.js), applied to marketplace_listings.
//
// Unlike Ad Banners (a bespoke per-row form), these three fields are edited
// through the fully generic "Manage Content" editor (adminContent.js) —
// this file also proves that editor's new selectFields mechanism actually
// enforces the enum, and that the 6 other resources it manages did NOT
// silently gain these fields.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-mktanim-'));
const port = 60000 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

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

let advertiserId, listingId;

before(async () => {
  pg = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'postgres', password: 'postgres', port,
    persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('unplug_test');

  process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${port}/unplug_test`;
  process.env.JWT_SECRET = 'test-secret-for-marketplace-poster-animation';

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

  const advertiser = await pool.query(
    `INSERT INTO advertisers (user_id, business_name, contact_email) VALUES (2, 'Acme Co', 'acme@test.com') RETURNING id`
  );
  advertiserId = advertiser.rows[0].id;

  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/admin/content', require('../src/routes/adminContent'));
  app.use('/marketplace', require('../src/routes/marketplace'));
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

test('THE MIGRATION ITSELF REJECTS AN INVALID EFFECT OR A NON-POSITIVE DURATION', async () => {
  await assert.rejects(
    pool.query(`INSERT INTO marketplace_listings (advertiser_id, poster_image_url, duration_days, animation_effect) VALUES ($1, 'https://a.test/p.jpg', 30, 'spin')`, [advertiserId]),
    /violates check constraint/
  );
  await assert.rejects(
    pool.query(`INSERT INTO marketplace_listings (advertiser_id, poster_image_url, duration_days, display_duration_ms) VALUES ($1, 'https://a.test/p.jpg', 30, 100)`, [advertiserId]),
    /violates check constraint/
  );
});

test('A FRESH LISTING WITH NO ANIMATION FIELDS SPECIFIED REPRODUCES TODAY\'S EXACT LOOK — NO extra entrance effect, the track\'s own 0.5s slide, 4-second rotation', async () => {
  const r = await pool.query(
    `INSERT INTO marketplace_listings (advertiser_id, poster_image_url, duration_days) VALUES ($1, 'https://a.test/untouched.jpg', 30) RETURNING *`,
    [advertiserId]
  );
  assert.equal(r.rows[0].animation_effect, 'none');
  assert.equal(r.rows[0].transition_duration_ms, 500);
  assert.equal(r.rows[0].display_duration_ms, 4000);
  listingId = r.rows[0].id;
});

test('GET /admin/content/marketplace DECLARES animation_effect AS A REAL ENUM, FOR THE GENERIC EDITOR TO RENDER A <select>', async () => {
  const r = await req('GET', '/admin/content/marketplace', { token: adminToken });
  assert.equal(r.status, 200);
  assert.ok(r.body.editable.includes('animation_effect'));
  assert.ok(r.body.editable.includes('transition_duration_ms'));
  assert.ok(r.body.editable.includes('display_duration_ms'));
  assert.deepEqual(r.body.selectFields.animation_effect,
    ['none', 'fade', 'fade-up', 'slide-up', 'slide-down', 'slide-left', 'slide-right', 'zoom']);
});

test('A NON-ADMIN CANNOT EDIT A LISTING\'S ANIMATION', async () => {
  const r = await req('PATCH', `/admin/content/marketplace/${listingId}`, {
    token: memberToken, body: { animation_effect: 'zoom' },
  });
  assert.equal(r.status, 403);
});

test('AN INVALID animation_effect IS A CLEAN 400, NOT A RAW DATABASE ERROR', async () => {
  const r = await req('PATCH', `/admin/content/marketplace/${listingId}`, {
    token: adminToken, body: { animation_effect: 'spin' },
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /animation_effect must be one of/);
});

test('A NON-POSITIVE _ms FIELD IS REJECTED THE SAME WAY', async () => {
  const r = await req('PATCH', `/admin/content/marketplace/${listingId}`, {
    token: adminToken, body: { display_duration_ms: -50 },
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /display_duration_ms must be a positive whole number/);
});

test('A VALID EDIT ROUND-TRIPS THROUGH TO THE PUBLIC LISTINGS ROUTE — and this is a PARTIAL patch, unlike Ad Banners\' full-row-replace, so the untouched poster_image_url survives', async () => {
  const r = await req('PATCH', `/admin/content/marketplace/${listingId}`, {
    token: adminToken, body: { animation_effect: 'zoom', transition_duration_ms: 700, display_duration_ms: 6000 },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.item.poster_image_url, 'https://a.test/untouched.jpg', 'a partial patch must not blank fields it did not mention');

  // Approve the listing so the public route (approved + in-schedule only) returns it.
  await pool.query(`UPDATE marketplace_listings SET status = 'approved' WHERE id = $1`, [listingId]);

  const pub = await req('GET', '/marketplace/listings');
  assert.equal(pub.status, 200);
  const listing = pub.body.listings.find((l) => l.id === listingId);
  assert.ok(listing);
  assert.equal(listing.animation_effect, 'zoom');
  assert.equal(listing.transition_duration_ms, 700);
  assert.equal(listing.display_duration_ms, 6000);
});

test('THE OTHER RESOURCES THIS GENERIC EDITOR MANAGES DID NOT SILENTLY GAIN THESE FIELDS', async () => {
  const articles = await req('GET', '/admin/content/articles', { token: adminToken });
  assert.equal(articles.status, 200);
  assert.ok(!articles.body.editable.includes('animation_effect'), 'articles must not be widened by this change');
  assert.deepEqual(articles.body.selectFields, {}, 'articles has no select fields');
});
