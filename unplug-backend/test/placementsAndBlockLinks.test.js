// Two admin-content changes:
//   - the Marketplace "Advertise With Us" rate card, previously hardcoded in
//     the page with grey size placeholders, now editable data with real
//     images (101_marketplace_placements.sql);
//   - portrait/square page blocks whose IMAGE can be a link, with an optional
//     visible "this is clickable" note (102_page_block_portrait_links.sql).
//
// The seeding matters as much as the CRUD: the migration must reproduce the
// seven cards the page already showed, so nothing changes until an admin
// edits something.
//
// Over real HTTP against real PostgreSQL. See universalComments.test.js for
// why require('../src/app') is avoided.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-placements-'));
const port = 30000 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

async function req(method, urlPath, { token, body } = {}) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, body: json };
}

let jwt;
function tokenFor(userId, role = 'member') {
  return jwt.sign({ id: userId, email: `pl${userId}@test.com`, role }, process.env.JWT_SECRET);
}

let _nextUserId = 63000;
async function makeUser(role = 'member') {
  const id = _nextUserId++;
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', $3) ON CONFLICT DO NOTHING`,
    [id, `pl${id}@test.com`, role]
  );
  return id;
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
  process.env.JWT_SECRET = 'test-secret-for-placements';
  process.env.UNPLUG_DISABLE_RATE_LIMITS = '1';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }

  jwt = require('jsonwebtoken');

  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/marketplace', require('../src/routes/marketplace'));
  app.use('/page-cms', require('../src/routes/pageContent'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await pool.end();
  // Windows can still hold a handle on the data directory when Postgres
  // exits, and embedded-postgres removes that directory as part of
  // stopping. The server is already down by then, so an EBUSY here is
  // the OS being slow to let go, not a failure worth failing the file
  // for — and a teardown that goes red teaches everyone to ignore red.
  try { if (pg) await pg.stop(); } catch (e) { /* see above */ }
});

// ---------------------------------------------------------------------------
// Marketplace placements
// ---------------------------------------------------------------------------

test('the seven cards the page already showed are seeded, in order', async () => {
  const { status, body } = await req('GET', '/marketplace/placements');
  assert.equal(status, 200);
  assert.equal(body.placements.length, 7);
  assert.deepEqual(
    body.placements.map((p) => p.slug),
    ['homepage-hero', 'top10-sponsor', 'directory-sponsor', 'sponsored-editorial',
      'newsletter-banner', 'competition-sponsor', 'business-placement'],
  );
  // Wording carried over verbatim, so the page reads identically.
  const hero = body.placements[0];
  assert.equal(hero.title, 'Homepage Hero Banner');
  assert.equal(hero.spec_label, '1240x200');
  assert.match(hero.description, /Maximum visibility at the top of the homepage/);
  // The premium card keeps its distinct treatment.
  assert.equal(body.placements[6].is_featured, true);
  assert.equal(body.placements.filter((p) => p.is_featured).length, 1);
});

test('an admin can give a placement a real image, and the public route serves it', async () => {
  const admin = await makeUser('admin');
  const before = await req('GET', '/marketplace/placements');
  const hero = before.body.placements.find((p) => p.slug === 'homepage-hero');
  assert.equal(hero.image_url, null, 'seeded placements start with no image');

  const patched = await req('PATCH', `/marketplace/admin/placements/${hero.id}`, {
    token: tokenFor(admin, 'admin'),
    body: { imageUrl: 'https://cdn.test/hero.jpg', description: 'Now with a real picture.' },
  });
  assert.equal(patched.status, 200);

  const after = await req('GET', '/marketplace/placements');
  const updated = after.body.placements.find((p) => p.slug === 'homepage-hero');
  assert.equal(updated.image_url, 'https://cdn.test/hero.jpg');
  assert.equal(updated.description, 'Now with a real picture.');
});

test('a new placement gets a slug derived from its title', async () => {
  const admin = await makeUser('admin');
  const created = await req('POST', '/marketplace/admin/placements', {
    token: tokenFor(admin, 'admin'),
    body: { title: 'Podcast Read!! 2026', description: 'Host-read spot', position: 20 },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.placement.slug, 'podcast-read-2026');
  assert.equal(created.body.placement.button_label, 'Get In Contact', 'sensible default');
  assert.equal(created.body.placement.button_target, 'contact');
});

test('hidden placements stay out of the public list but remain visible to an admin', async () => {
  const admin = await makeUser('admin');
  const list = await req('GET', '/marketplace/admin/placements', { token: tokenFor(admin, 'admin') });
  const target = list.body.placements.find((p) => p.slug === 'newsletter-banner');

  await req('PATCH', `/marketplace/admin/placements/${target.id}`, {
    token: tokenFor(admin, 'admin'), body: { isVisible: false },
  });

  const pub = await req('GET', '/marketplace/placements');
  assert.equal(pub.body.placements.some((p) => p.slug === 'newsletter-banner'), false);
  const adminList = await req('GET', '/marketplace/admin/placements', { token: tokenFor(admin, 'admin') });
  assert.equal(adminList.body.placements.some((p) => p.slug === 'newsletter-banner'), true);

  await req('PATCH', `/marketplace/admin/placements/${target.id}`, {
    token: tokenFor(admin, 'admin'), body: { isVisible: true },
  });
});

test('managing placements is admin-only', async () => {
  const member = await makeUser();
  assert.equal((await req('GET', '/marketplace/admin/placements', { token: tokenFor(member) })).status, 403);
  assert.equal((await req('POST', '/marketplace/admin/placements', {
    token: tokenFor(member), body: { title: 'Sneaky' },
  })).status, 403);
});

// ---------------------------------------------------------------------------
// Portrait page blocks with clickable images
// ---------------------------------------------------------------------------

test('a portrait block with a clickable image and a hint round-trips', async () => {
  const admin = await makeUser('admin');
  const created = await req('POST', '/page-cms/admin/blocks', {
    token: tokenFor(admin, 'admin'),
    body: {
      pageKey: 'home', title: 'Our new range', description: 'Portrait promo',
      imageUrl: 'https://cdn.test/portrait.jpg',
      orientation: 'portrait',
      imageLinkUrl: 'https://shop.test/range',
      showClickHint: true,
      clickHintText: 'Tap to shop the range',
    },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.block.orientation, 'portrait');
  assert.equal(created.body.block.image_link_url, 'https://shop.test/range');
  assert.equal(created.body.block.show_click_hint, true);
  assert.equal(created.body.block.click_hint_text, 'Tap to shop the range');

  const pub = await req('GET', '/page-cms');
  const block = (pub.body.blocks.home || []).find((b) => b.id === created.body.block.id);
  assert.ok(block, 'the block should be served publicly');
  assert.equal(block.orientation, 'portrait');
  assert.equal(block.image_link_url, 'https://shop.test/range');
});

test('existing blocks are unaffected — no orientation given means landscape', async () => {
  const admin = await makeUser('admin');
  const created = await req('POST', '/page-cms/admin/blocks', {
    token: tokenFor(admin, 'admin'),
    body: { pageKey: 'home', title: 'Plain block', imageUrl: 'https://cdn.test/x.jpg' },
  });
  assert.equal(created.body.block.orientation, 'landscape');
  assert.equal(created.body.block.image_link_url, null);
  assert.equal(created.body.block.show_click_hint, false);
});

test('the click hint is refused when the image links nowhere', async () => {
  // A note saying "click this image" on an image that is not a link would be
  // a plain lie to the reader, so the flag does not stick without a link.
  const admin = await makeUser('admin');
  const created = await req('POST', '/page-cms/admin/blocks', {
    token: tokenFor(admin, 'admin'),
    body: { pageKey: 'home', title: 'No link', imageUrl: 'https://cdn.test/y.jpg', showClickHint: true },
  });
  assert.equal(created.body.block.show_click_hint, false);
});

test('an unknown orientation is rejected rather than stored', async () => {
  const admin = await makeUser('admin');
  const created = await req('POST', '/page-cms/admin/blocks', {
    token: tokenFor(admin, 'admin'),
    body: { pageKey: 'home', title: 'Bad shape', imageUrl: 'https://cdn.test/z.jpg', orientation: 'diagonal' },
  });
  // POST falls back to the safe default rather than failing the whole create.
  assert.equal(created.body.block.orientation, 'landscape');

  // PATCH is explicit, so a bad value there is a clear 400.
  const patched = await req('PATCH', `/page-cms/admin/blocks/${created.body.block.id}`, {
    token: tokenFor(admin, 'admin'), body: { orientation: 'diagonal' },
  });
  assert.equal(patched.status, 400);
});

test('re-running every migration is idempotent — placements and blocks survive', async () => {
  const admin = await makeUser('admin');
  const list = await req('GET', '/marketplace/admin/placements', { token: tokenFor(admin, 'admin') });
  const hero = list.body.placements.find((p) => p.slug === 'homepage-hero');
  // An edit made before the re-run must NOT be reverted by the seed.
  await req('PATCH', `/marketplace/admin/placements/${hero.id}`, {
    token: tokenFor(admin, 'admin'), body: { title: 'Edited Hero Title' },
  });

  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }

  const after = await req('GET', '/marketplace/placements');
  const stillEdited = after.body.placements.find((p) => p.slug === 'homepage-hero');
  assert.equal(stillEdited.title, 'Edited Hero Title', 're-seeding must not overwrite an admin edit');
  assert.ok(after.body.placements.length >= 7);
});
