// Admin-swappable site pictures, against a REAL PostgreSQL.
//
// A picture is made changeable in two places — a data-cms-img tag in
// unplug-magazine.html and an entry in utils/siteImages.js — and this codebase
// has been bitten by that shape more than once: a price list that "mirrors"
// another price list drifts the moment somebody changes one side. So the first
// test here reads the actual HTML and checks BOTH directions. A key with no
// tag is an upload field that changes nothing on the site; a tag with no key
// is a picture nobody can reach.
//
// The rest is about what may become an <img src> on the public homepage. The
// value is validated when it is SAVED, not only when it is rendered, because a
// stored javascript: URL is one forgetful template away from being a hole.
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
let jwt;
let siteImages;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-siteimg-'));
const port = 33200 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

async function req(method, urlPath, { token, body } = {}) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, body: json };
}

function tokenFor(userId, role = 'member') {
  return jwt.sign({ id: userId, email: `si${userId}@test.com`, role }, process.env.JWT_SECRET);
}

let _nextUserId = 771000;
async function makeUser(role = 'member') {
  const id = _nextUserId++;
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', $3) ON CONFLICT DO NOTHING`,
    [id, `si${id}@test.com`, role]);
  return id;
}

async function storedValue(key) {
  const { splitKey } = siteImages;
  const p = splitKey(key);
  const r = await pool.query(
    'SELECT value FROM page_content WHERE page_key = $1 AND content_key = $2',
    [p.pageKey, p.contentKey]);
  return r.rowCount ? r.rows[0].value : null;
}

let adminToken;
let memberToken;
let FIRST_KEY;

before(async () => {
  pg = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'postgres', password: 'postgres', port,
    persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('unplug_test');

  process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${port}/unplug_test`;
  process.env.JWT_SECRET = 'test-secret-for-site-images';
  process.env.UNPLUG_DISABLE_RATE_LIMITS = '1';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }

  jwt = require('jsonwebtoken');
  siteImages = require('../src/utils/siteImages');
  FIRST_KEY = siteImages.SITE_IMAGES[0].key;

  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/page-cms', require('../src/routes/pageContent'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  adminToken = tokenFor(await makeUser('admin'), 'admin');
  memberToken = tokenFor(await makeUser());
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  // stopPostgres, not pg.stop() directly: on Windows the library's stop
  // can HANG rather than throw, which used to leave the cluster running
  // with no parent and eventually broke a later test file's startup.
  // See test/helpers/stopPostgres.js.
  await stopPostgres(pg, dataDir);
});

// ---------------------------------------------------------------------------
// The registry and the page must agree
// ---------------------------------------------------------------------------

test('EVERY REGISTERED IMAGE IS ACTUALLY TAGGED IN THE PAGE, AND VICE VERSA', () => {
  const htmlPath = path.join(__dirname, '..', '..', 'unplug-magazine.html');
  const html = fs.readFileSync(htmlPath, 'utf8');

  const tagged = new Set();
  const re = /data-cms-img\s*=\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) tagged.add(m[1]);

  const registered = new Set(siteImages.SITE_IMAGES.map((i) => i.key));

  const registeredButNotTagged = [...registered].filter((k) => !tagged.has(k));
  const taggedButNotRegistered = [...tagged].filter((k) => !registered.has(k));

  assert.deepEqual(registeredButNotTagged, [],
    'these keys give the admin an upload field that changes nothing on the site');
  assert.deepEqual(taggedButNotRegistered, [],
    'these pictures are tagged as swappable but no admin control exists for them');
  assert.ok(registered.size > 0, 'there is at least one swappable image');
});

test('the broken hardcoded image is gone from the page', () => {
  // The block used to point at feature-edition.jpeg, which was never
  // committed, so the homepage rendered a broken-image icon.
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'unplug-magazine.html'), 'utf8');
  assert.ok(!/src\s*=\s*"feature-edition\.jpe?g"/i.test(html),
    'that file does not exist and its src must not be hardcoded again');
});

// ---------------------------------------------------------------------------
// What may become an <img src>
// ---------------------------------------------------------------------------

test('A javascript: URL IS REFUSED, NOT STORED', async () => {
  const bad = await req('PUT', '/page-cms/admin/site-images', {
    token: adminToken, body: { key: FIRST_KEY, value: 'javascript:alert(document.cookie)' },
  });
  assert.equal(bad.status, 400);
  assert.equal(await storedValue(FIRST_KEY), null, 'nothing was written');
});

test('other unsafe or ambiguous addresses are refused', async () => {
  for (const attempt of [
    'data:image/svg+xml,<svg onload=alert(1)>',
    '//evil.example.com/x.jpg',            // protocol-relative: not our host
    'http://insecure.example.com/a.jpg',   // plain http on an https site
    'feature-edition.jpeg',                // bare relative: the original bug
    'vbscript:msgbox(1)',
  ]) {
    assert.equal(siteImages.isSafeImageUrl(attempt), false, `${attempt} must be refused`);
    const r = await req('PUT', '/page-cms/admin/site-images', {
      token: adminToken, body: { key: FIRST_KEY, value: attempt },
    });
    assert.equal(r.status, 400, `${attempt} must not be accepted by the route`);
  }
});

test('an https URL and a site-relative path are both accepted', async () => {
  const abs = await req('PUT', '/page-cms/admin/site-images', {
    token: adminToken, body: { key: FIRST_KEY, value: 'https://cdn.example.com/feature.jpg' },
  });
  assert.equal(abs.status, 200);
  assert.equal(await storedValue(FIRST_KEY), 'https://cdn.example.com/feature.jpg');

  const rel = await req('PUT', '/page-cms/admin/site-images', {
    token: adminToken, body: { key: FIRST_KEY, value: '/uploads/feature.jpg' },
  });
  assert.equal(rel.status, 200);
  assert.equal(await storedValue(FIRST_KEY), '/uploads/feature.jpg',
    'an uploaded file lives on our own host');
});

test('an unknown key is refused, so the route cannot write arbitrary CMS keys', async () => {
  // This endpoint bypasses nothing else's validation; it must stay confined
  // to the pictures on the list.
  const bad = await req('PUT', '/page-cms/admin/site-images', {
    token: adminToken, body: { key: 'home.hero.title', value: 'https://x.example.com/a.jpg' },
  });
  assert.equal(bad.status, 404);
  const leaked = await pool.query(
    `SELECT 1 FROM page_content WHERE page_key = 'home' AND content_key = 'hero.title'`);
  assert.equal(leaked.rowCount, 0, 'it must not have written to a wording key');
});

// ---------------------------------------------------------------------------
// Setting, clearing, listing
// ---------------------------------------------------------------------------

test('clearing an image empties that spot rather than leaving the old one', async () => {
  await req('PUT', '/page-cms/admin/site-images', {
    token: adminToken, body: { key: FIRST_KEY, value: 'https://cdn.example.com/old.jpg' },
  });
  const cleared = await req('PUT', '/page-cms/admin/site-images', {
    token: adminToken, body: { key: FIRST_KEY, value: '' },
  });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.cleared, true);
  assert.equal(await storedValue(FIRST_KEY), null);
});

test('the admin list carries the label, the hint and whatever is set', async () => {
  await req('PUT', '/page-cms/admin/site-images', {
    token: adminToken, body: { key: FIRST_KEY, value: 'https://cdn.example.com/current.jpg' },
  });
  const list = await req('GET', '/page-cms/admin/site-images', { token: adminToken });
  assert.equal(list.status, 200);
  const entry = list.body.images.find((i) => i.key === FIRST_KEY);
  assert.ok(entry.label, 'an admin sees which picture this is without opening the page');
  assert.equal(entry.value, 'https://cdn.example.com/current.jpg');
});

test('an image that has never been set reads as empty, not missing', async () => {
  await req('PUT', '/page-cms/admin/site-images', {
    token: adminToken, body: { key: FIRST_KEY, value: '' },
  });
  const list = await req('GET', '/page-cms/admin/site-images', { token: adminToken });
  const entry = list.body.images.find((i) => i.key === FIRST_KEY);
  assert.equal(entry.value, null, 'the screen can say "nothing set" rather than erroring');
});

test('THE PUBLIC PAGE-CMS FEED CARRIES THE IMAGE SO THE SITE CAN RENDER IT', async () => {
  await req('PUT', '/page-cms/admin/site-images', {
    token: adminToken, body: { key: FIRST_KEY, value: 'https://cdn.example.com/live.jpg' },
  });
  const publicFeed = await req('GET', '/page-cms');
  assert.equal(publicFeed.status, 200);
  assert.equal(publicFeed.body.content[FIRST_KEY], 'https://cdn.example.com/live.jpg',
    'the frontend looks this key up by name — without it the picture never appears');
});

// ---------------------------------------------------------------------------
// Who can do what
// ---------------------------------------------------------------------------

test('only an admin can change a picture on the site', async () => {
  const asMember = await req('PUT', '/page-cms/admin/site-images', {
    token: memberToken, body: { key: FIRST_KEY, value: 'https://cdn.example.com/x.jpg' },
  });
  assert.equal(asMember.status, 403);

  const asAnon = await req('PUT', '/page-cms/admin/site-images', {
    body: { key: FIRST_KEY, value: 'https://cdn.example.com/x.jpg' },
  });
  assert.equal(asAnon.status, 401);

  const listAsMember = await req('GET', '/page-cms/admin/site-images', { token: memberToken });
  assert.equal(listAsMember.status, 403);
});
