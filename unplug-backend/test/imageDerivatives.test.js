// Storing derivatives and publishing the manifest, against a REAL PostgreSQL.
//
// The failure this file exists to prevent: THE MANIFEST PROMISING A FILE THAT
// IS NOT THERE. The frontend reads the manifest as a guarantee, and a browser
// given a srcset entry that 404s shows a broken image rather than falling back.
// So the order of operations — upload everything, only then record it — is
// pinned here, including the case where an upload fails halfway.
//
// Run with:  npm test   (from unplug-backend/)

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const sharp = require('sharp');
const EmbeddedPostgres = require('embedded-postgres').default;
const { stopPostgres } = require('./helpers/stopPostgres');

let pg;
let pool;
let server;
let baseUrl;
let jwt;
let store;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-img-'));
const port = 36400 + (process.pid % 300); // bases are 400 apart so ranges cannot overlap

async function req(urlPath, token) {
  const res = await fetch(baseUrl + urlPath, {
    headers: token ? { Authorization: 'Bearer ' + token } : {},
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: res.status, body: json, headers: res.headers };
}

// A photographic-looking source; flat colour would compress to nothing and
// make the byte assertions meaningless.
async function photo(width, height) {
  const px = Buffer.alloc(width * height * 3);
  for (let i = 0; i < px.length; i += 3) {
    px[i] = (i * 7) % 255; px[i + 1] = (i * 13) % 255; px[i + 2] = (i * 29) % 255;
  }
  return sharp(px, { raw: { width, height, channels: 3 } }).jpeg({ quality: 92 }).toBuffer();
}

// A putObject that records what it was asked to store instead of talking to
// Supabase. The store takes this as a parameter precisely so this is possible.
function fakeStorage() {
  const put = async (key, buffer, mime) => { put.written.push({ key, bytes: buffer.length, mime }); };
  put.written = [];
  return put;
}

let adminToken;

before(async () => {
  pg = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'postgres', password: 'postgres', port,
    persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('unplug_test');

  process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${port}/unplug_test`;
  process.env.JWT_SECRET = 'test-secret-for-images';
  process.env.UNPLUG_DISABLE_RATE_LIMITS = '1';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }

  jwt = require('jsonwebtoken');
  store = require('../src/utils/imageDerivativeStore');

  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/images', require('../src/routes/images'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await pool.query(`INSERT INTO users (id, email, password_hash, role)
                    VALUES (881001, 'imgadmin@test.com', 'x', 'admin')`);
  adminToken = jwt.sign({ id: 881001, email: 'imgadmin@test.com', role: 'admin' }, process.env.JWT_SECRET);
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
// Storing
// ---------------------------------------------------------------------------

test('every derivative is uploaded, and then recorded', async () => {
  const put = fakeStorage();
  const buf = await photo(1600, 800);
  const result = await store.storeDerivatives({ key: '100-a.jpg', buffer: buf, putObject: put });

  assert.equal(result.skipped, null);
  assert.ok(result.made > 0);
  assert.equal(put.written.length, result.made, 'one upload per derivative');
  assert.ok(put.written.every((w) => w.key.startsWith('derivatives/100-a-')),
    'all stored under the derivatives prefix, keyed off the original');

  const row = (await pool.query('SELECT * FROM image_derivatives WHERE object_key = $1', ['100-a.jpg'])).rows[0];
  assert.ok(row, 'a manifest row exists');
  assert.deepEqual(row.formats.sort(), ['avif', 'webp']);
  assert.equal(row.skipped_reason, null);
  assert.equal(row.source_width, 1600);
  assert.ok(Number(row.derivative_bytes) > 0);
});

test('NOTHING IS RECORDED WHEN AN UPLOAD FAILS', async () => {
  // The failure that would put a broken image on the site: a row saying the
  // files are there when they are not. If storage breaks halfway, the manifest
  // must stay silent and the original keep being served.
  const failing = async (key) => {
    if (key.includes('-800.')) throw new Error('storage went away');
  };
  const buf = await photo(1600, 800);

  await assert.rejects(
    () => store.storeDerivatives({ key: '101-b.jpg', buffer: buf, putObject: failing }),
    /storage went away/);

  const rows = await pool.query('SELECT * FROM image_derivatives WHERE object_key = $1', ['101-b.jpg']);
  assert.equal(rows.rowCount, 0, 'no half-true manifest row was left behind');
});

test('an unreadable file is recorded as skipped, not retried forever', async () => {
  const put = fakeStorage();
  const notAnImage = Buffer.from('%PDF-1.4 this is not a picture');
  const result = await store.storeDerivatives({ key: '102-c.png', buffer: notAnImage, putObject: put });

  assert.equal(result.made, 0);
  assert.match(result.skipped, /unreadable/);
  assert.equal(put.written.length, 0, 'nothing was uploaded');

  const row = (await pool.query('SELECT * FROM image_derivatives WHERE object_key = $1', ['102-c.png'])).rows[0];
  assert.ok(row, 'it is on the record');
  assert.match(row.skipped_reason, /unreadable/);
  // The difference that stops the backfill looping: "looked at and skipped" is
  // a row; "not looked at yet" is no row.
  assert.deepEqual(row.widths, []);
});

test('RE-RUNNING CLEARS A PREVIOUS SKIP', async () => {
  // An image that failed once and succeeds on a retry must stop being reported
  // as a problem.
  const put = fakeStorage();
  await store.storeDerivatives({ key: '103-d.jpg', buffer: Buffer.from('rubbish'), putObject: put });
  let row = (await pool.query('SELECT skipped_reason FROM image_derivatives WHERE object_key = $1', ['103-d.jpg'])).rows[0];
  assert.ok(row.skipped_reason);

  await store.storeDerivatives({ key: '103-d.jpg', buffer: await photo(900, 500), putObject: put });
  row = (await pool.query('SELECT skipped_reason, widths FROM image_derivatives WHERE object_key = $1', ['103-d.jpg'])).rows[0];
  assert.equal(row.skipped_reason, null, 'the old failure no longer shadows the success');
  assert.ok(row.widths.length > 0);
});

test('the object key is recovered from a public storage URL', async () => {
  const url = 'https://abc.supabase.co/storage/v1/object/public/uploads/1785-photo.png';
  assert.equal(store.keyFromPublicUrl(url), '1785-photo.png');
  // A cache-busting query is not part of the key.
  assert.equal(store.keyFromPublicUrl(url + '?v=2'), '1785-photo.png');
  // Anything that is not a public storage URL has no key, and must not be
  // guessed at — an external image would otherwise get a srcset pointing into
  // our bucket.
  assert.equal(store.keyFromPublicUrl('https://example.com/photo.png'), null);
  assert.equal(store.keyFromPublicUrl(null), null);
});

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

test('THE MANIFEST LISTS ONLY IMAGES WHOSE FILES EXIST', async () => {
  const put = fakeStorage();
  await store.storeDerivatives({ key: '200-good.jpg', buffer: await photo(1600, 900), putObject: put });
  await store.storeDerivatives({ key: '201-bad.png', buffer: Buffer.from('nope'), putObject: put });

  const r = await req('/images/manifest');
  assert.equal(r.status, 200);
  assert.ok(r.body.images['200-good.jpg'], 'the processed one is offered');
  assert.ok(!r.body.images['201-bad.png'], 'the skipped one is NOT offered');
});

test('the manifest carries the ladder once, not on every entry', async () => {
  const r = await req('/images/manifest');
  assert.deepEqual(r.body.widths, [400, 800, 1200, 1600]);
  assert.deepEqual(r.body.formats.map((f) => f.ext), ['avif', 'webp'],
    'AVIF is offered first, so a browser that understands it never takes WebP');
  assert.equal(r.body.prefix, 'derivatives/');
  // An image on the standard ladder says so by carrying no widths of its own.
  assert.equal(r.body.images['200-good.jpg'].w, null);
});

test('an image narrower than the ladder carries its own widths', async () => {
  const put = fakeStorage();
  await store.storeDerivatives({ key: '202-small.jpg', buffer: await photo(300, 300), putObject: put });
  const r = await req('/images/manifest');
  const entry = r.body.images['202-small.jpg'];
  assert.ok(Array.isArray(entry.w), 'it does not claim the standard ladder');
  assert.ok(Math.max(...entry.w) <= 300, 'and offers nothing wider than it is');
});

test('intrinsic dimensions travel with each image', async () => {
  // This is what lets the page reserve space and stop shifting as pictures
  // land — 0.343 CLS on mobile today, nearly all of it one unsized image.
  const r = await req('/images/manifest');
  assert.deepEqual(r.body.images['200-good.jpg'].d, [1600, 900]);
});

test('the manifest is public and cacheable', async () => {
  // A crawler and a signed-out reader both need it, and it must not become
  // load: an unchanged manifest should cost a 304.
  const r = await req('/images/manifest');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('cache-control') || '', /max-age=\d+/);
  assert.ok(r.headers.get('etag'), 'an ETag is present so repeat asks are cheap');
});

test('the savings report is admin-only and counts real bytes', async () => {
  assert.equal((await req('/images/stats')).status, 401);

  const r = await req('/images/stats', adminToken);
  assert.equal(r.status, 200);
  assert.ok(r.body.processed >= 2);
  assert.ok(r.body.skipped >= 1);
  // The claim that matters: what a READER downloads is smaller. Comparing the
  // sum of all eight derivatives instead would measure the storage bill and
  // could legitimately exceed the originals — which is exactly the confusion
  // this pair of numbers exists to prevent.
  assert.ok(r.body.deliveredBytes > 0);
  assert.ok(r.body.deliveredBytes < r.body.originalBytes,
    `a reader downloads ${r.body.deliveredBytes} instead of ${r.body.originalBytes}`);
  assert.ok(r.body.skippedItems.some((i) => i.skipped_reason),
    'and it says which files were left alone, and why');
});
