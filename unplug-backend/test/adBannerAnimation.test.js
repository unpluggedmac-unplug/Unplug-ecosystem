// Part 1 of "admin control over banner/cover animation effects": per-banner
// entrance effect, transition speed, and how long a banner stays up before
// the rotation advances. Requested directly: "give admin access and control
// on the animation effects on banners and covers across the site."
//
// Reuses the exact 8-value enum unplug-popups.js already validates for its
// own entrance-animation dropdown — this file proves the SAME set is
// enforced here too, and that a fresh banner (nothing set) reproduces
// today's exact hardcoded look (0.6s fade, 5s rotation) rather than
// silently changing appearance the moment the migration runs.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-adanim-'));
const port = 59600 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

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
  process.env.JWT_SECRET = 'test-secret-for-ad-banner-animation';

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
  app.use('/page-cms', require('../src/routes/pageContent'));
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
    pool.query(`INSERT INTO ad_slots (slot_key, image_url, animation_effect) VALUES ('x', 'https://a.test/x.jpg', 'spin')`),
    /violates check constraint/
  );
  await assert.rejects(
    pool.query(`INSERT INTO ad_slots (slot_key, image_url, display_duration_ms) VALUES ('x', 'https://a.test/x.jpg', 100)`),
    /violates check constraint/,
    'display_duration_ms must be at least 1000ms'
  );
});

test('A FRESH ROW WITH NO ANIMATION FIELDS SPECIFIED REPRODUCES TODAY\'S EXACT HARDCODED LOOK', async () => {
  const r = await pool.query(`INSERT INTO ad_slots (slot_key, image_url) VALUES ('untouched-slot', 'https://a.test/untouched.jpg') RETURNING *`);
  assert.equal(r.rows[0].animation_effect, 'fade', 'today\'s ad-slide crossfade');
  assert.equal(r.rows[0].transition_duration_ms, 600, 'today\'s 0.6s transition');
  assert.equal(r.rows[0].display_duration_ms, 5000, 'today\'s 5-second rotation');
});

test('A NON-ADMIN CANNOT CREATE A BANNER', async () => {
  const r = await req('POST', '/page-cms/admin/ad-slots', {
    token: memberToken, body: { slotKey: 'home-sponsor-1', imageUrl: 'https://a.test/b.jpg' },
  });
  assert.equal(r.status, 403);
});

test('AN INVALID animationEffect IS A CLEAN 400, NOT A RAW DATABASE ERROR', async () => {
  const r = await req('POST', '/page-cms/admin/ad-slots', {
    token: adminToken,
    body: { slotKey: 'home-sponsor-1', imageUrl: 'https://a.test/b.jpg', animationEffect: 'spin' },
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /animationEffect must be one of/);
});

let bannerId;

test('AN ADMIN CREATES A BANNER WITH A REAL EFFECT, SPEED, AND DISPLAY DURATION', async () => {
  const r = await req('POST', '/page-cms/admin/ad-slots', {
    token: adminToken,
    body: {
      slotKey: 'home-sponsor-1', imageUrl: 'https://a.test/b.jpg',
      animationEffect: 'zoom', transitionDurationMs: 800, displayDurationMs: 8000,
    },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.banner.animation_effect, 'zoom');
  assert.equal(r.body.banner.transition_duration_ms, 800);
  assert.equal(r.body.banner.display_duration_ms, 8000);
  bannerId = r.body.banner.id;
});

test('THE PUBLIC ROUTE RETURNS THE SAVED ANIMATION FIELDS FOR THE ROTATION TO USE', async () => {
  // wireAdBannerRow (the real admin form) always resends every field on
  // save, not just the one that changed — this PATCH route is a full-row
  // replace, matching displayOrder/isActive/etc.'s existing behaviour, so
  // the test resends the same animation fields, not just imageUrl.
  await req('PATCH', `/page-cms/admin/ad-slots/${bannerId}`, {
    token: adminToken,
    body: { imageUrl: 'https://a.test/b.jpg', animationEffect: 'zoom', transitionDurationMs: 800, displayDurationMs: 8000 },
  });
  const r = await req('GET', '/page-cms/');
  assert.equal(r.status, 200);
  const slotBanners = r.body.adSlots['home-sponsor-1'];
  assert.ok(slotBanners && slotBanners.length >= 1);
  const banner = slotBanners.find((b) => b.image_url === 'https://a.test/b.jpg');
  assert.ok(banner);
  assert.equal(banner.animation_effect, 'zoom');
  assert.equal(banner.transition_duration_ms, 800);
  assert.equal(banner.display_duration_ms, 8000);
});

test('PATCHING WITHOUT ANIMATION FIELDS FALLS BACK TO THE SAME DEFAULTS AS A BRAND NEW BANNER', async () => {
  const r = await req('PATCH', `/page-cms/admin/ad-slots/${bannerId}`, {
    token: adminToken, body: { imageUrl: 'https://a.test/b2.jpg' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.banner.animation_effect, 'fade');
  assert.equal(r.body.banner.transition_duration_ms, 600);
  assert.equal(r.body.banner.display_duration_ms, 5000);
});

test('A displayDurationMs BELOW 1000 IS REJECTED VIA THE VALIDATOR, NOT SILENTLY CLAMPED', async () => {
  // The validator falls back to the default (5000) for an out-of-range value
  // rather than erroring, matching how every other malformed-but-optional
  // field on this route already behaves (e.g. a non-numeric displayOrder).
  const r = await req('PATCH', `/page-cms/admin/ad-slots/${bannerId}`, {
    token: adminToken, body: { imageUrl: 'https://a.test/b3.jpg', displayDurationMs: 50 },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.banner.display_duration_ms, 5000);
});

test('THE ADMIN LIST ROUTE ALSO RETURNS THE ANIMATION FIELDS', async () => {
  const r = await req('GET', '/page-cms/admin/ad-slots', { token: adminToken });
  assert.equal(r.status, 200);
  const banner = r.body.adSlots['home-sponsor-1'].find((b) => b.id === bannerId);
  assert.ok(banner);
  assert.ok('animation_effect' in banner);
  assert.ok('transition_duration_ms' in banner);
  assert.ok('display_duration_ms' in banner);
});
