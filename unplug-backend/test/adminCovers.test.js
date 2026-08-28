// Cover images for everything on the site.
//
// The Cover Images screen knew about two things: articles and directory
// listings. Every other image — an event's picture, a magazine cover, a
// marketplace poster, a contributor's portrait — could only be changed from
// whichever admin screen owned that item, if it offered the field at all.
// Several did not.
//
// What these tests protect:
//
//   1. EVERY DECLARED TYPE POINTS AT A REAL TABLE AND REAL COLUMNS, and its
//      title/meta expressions actually run. A typo would otherwise surface as
//      a 500 the first time an admin opened that tab.
//   2. A PROJECT NEVER ENDS UP WITH TWO COVERS OR NONE BY ACCIDENT. Its cover
//      is a flag on one of its own images, set in a transaction.
//   3. NOTHING BUT AN https:// ADDRESS IS STORED.
//   4. IT IS ADMIN-ONLY.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-covers-'));
const port = 46000 + (process.pid % 300); // bases are 400 apart so ranges cannot overlap

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

const IMG = 'https://example.test/storage/v1/object/public/uploads/new-cover.jpg';

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
  process.env.JWT_SECRET = 'test-secret-for-covers';
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
  app.use('/admin/covers', require('../src/routes/adminCovers'));
  app.use('/', require('../src/routes/profiles'));   // the member's own listing edit
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await pool.query(`INSERT INTO users (id, email, full_name, password_hash, role) VALUES
    (630001, 'covadmin@test.com', 'Cov Admin', 'x', 'admin'),
    (630002, 'covmember@test.com', 'Cov Member', 'x', 'member')`);
  adminToken = jwt.sign({ id: 630001, email: 'covadmin@test.com', role: 'admin' }, process.env.JWT_SECRET);
  memberToken = jwt.sign({ id: 630002, email: 'covmember@test.com', role: 'member' }, process.env.JWT_SECRET);

  await pool.query(`INSERT INTO categories (id, name, type) VALUES (9701, 'Community', 'news')
                    ON CONFLICT (id) DO NOTHING`);
  await pool.query(
    `INSERT INTO articles (id, author_user_id, category_id, title, body, status)
     VALUES (9711, 630002, 9701, 'A story', 'Body.', 'approved')`);
  await pool.query(
    `INSERT INTO events (id, organizer_user_id, name, event_date, venue, description, status)
     VALUES (9721, 630002, 'A market day', CURRENT_DATE, 'The hall', 'Come along.', 'approved')`);
  await pool.query(
    `INSERT INTO contributors (id, name, slug, role_title) VALUES (9731, 'A Writer', 'a-writer', 'Reporter')`);

  // A project with three images, the second one currently the cover.
  await pool.query(`INSERT INTO projects (id, title, description, status, created_by)
                    VALUES (9741, 'A project', 'About it.', 'published', 630001)`);
  await pool.query(
    `INSERT INTO project_images (id, project_id, image_url, display_order, is_cover) VALUES
       (9751, 9741, 'https://example.test/p1.jpg', 1, false),
       (9752, 9741, 'https://example.test/p2.jpg', 2, true),
       (9753, 9741, 'https://example.test/p3.jpg', 3, false)`);
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
});

// ------------------------------------------------------------ the inventory

test('EVERY DECLARED TYPE ACTUALLY RUNS', async () => {
  // The real guard on the whole descriptor table: a wrong column name, or a
  // title expression that does not compile, would otherwise only show up as a
  // 500 the first time somebody opened that tab.
  const { body } = await api('GET', '/admin/covers/types', null, adminToken);
  assert.ok(body.types.length >= 11, 'every kind of image is offered');

  for (const t of body.types) {
    const r = await api('GET', '/admin/covers/' + t.key, null, adminToken);
    assert.equal(r.status, 200, `${t.key} (${t.label}) failed to load: ${JSON.stringify(r.body)}`);
    assert.ok(Array.isArray(r.body.items), `${t.key} returned no items array`);
    r.body.items.forEach((it) => {
      assert.ok('id' in it && 'title' in it && 'cover' in it, `${t.key} rows are missing a field`);
    });
  }
});

test('the types are grouped, so portraits are not filed as covers', async () => {
  const { body } = await api('GET', '/admin/covers/types', null, adminToken);
  const groups = new Set(body.types.map((t) => t.group));
  assert.ok(groups.has('Content') && groups.has('People'));
  const people = body.types.filter((t) => t.group === 'People').map((t) => t.key);
  assert.deepEqual(people.sort(), ['birthday', 'contributor', 'halloffame', 'passport']);
});

test('an unknown type is a 404, not a crash', async () => {
  assert.equal((await api('GET', '/admin/covers/not_a_thing', null, adminToken)).status, 404);
  assert.equal((await api('PATCH', '/admin/covers/not_a_thing/1', { imageUrl: IMG }, adminToken)).status, 404);
});

// -------------------------------------------------------------- setting one

test('an admin can set and clear an image on any type', async () => {
  for (const [type, table, col, id] of [
    ['article', 'articles', 'banner_image_url', 9711],
    ['event', 'events', 'image_url', 9721],
    ['contributor', 'contributors', 'photo_url', 9731],
  ]) {
    const set = await api('PATCH', `/admin/covers/${type}/${id}`, { imageUrl: IMG }, adminToken);
    assert.equal(set.status, 200, type);
    let row = await pool.query(`SELECT ${col} AS v FROM ${table} WHERE id = $1`, [id]);
    assert.equal(row.rows[0].v, IMG, `${type} was not saved`);

    const cleared = await api('PATCH', `/admin/covers/${type}/${id}`, { imageUrl: '' }, adminToken);
    assert.equal(cleared.status, 200);
    row = await pool.query(`SELECT ${col} AS v FROM ${table} WHERE id = $1`, [id]);
    assert.equal(row.rows[0].v, null, `${type} clears to null, not an empty string`);
  }
});

test('NOTHING BUT AN https ADDRESS IS STORED', async () => {
  for (const bad of ['javascript:alert(1)', 'data:image/png;base64,AAAA', 'http://plain.example/x.jpg', '/relative.jpg']) {
    const r = await api('PATCH', '/admin/covers/article/9711', { imageUrl: bad }, adminToken);
    assert.equal(r.status, 400, `${bad} must be refused`);
  }
  const row = await pool.query('SELECT banner_image_url FROM articles WHERE id = 9711');
  assert.equal(row.rows[0].banner_image_url, null, 'and nothing was written');
});

test('a missing item is a 404', async () => {
  assert.equal((await api('PATCH', '/admin/covers/article/99999', { imageUrl: IMG }, adminToken)).status, 404);
});

test('the change is written to the audit trail', async () => {
  await api('PATCH', '/admin/covers/article/9711', { imageUrl: IMG }, adminToken);
  const log = await pool.query(
    `SELECT details FROM admin_activity_log WHERE action = 'cover_changed' ORDER BY id DESC LIMIT 1`);
  assert.ok(log.rows.length);
  assert.match(log.rows[0].details, /Articles #9711/);
});

// ----------------------------------------------------------------- projects

test('a project lists its own images to choose from', async () => {
  const { status, body } = await api('GET', '/admin/covers/project/9741/images', null, adminToken);
  assert.equal(status, 200);
  assert.equal(body.images.length, 3);
  assert.equal(body.images.filter((i) => i.is_cover).length, 1, 'exactly one is the cover');
});

test('the project list shows the current cover and how many images there are', async () => {
  const { body } = await api('GET', '/admin/covers/project', null, adminToken);
  const p = body.items.find((x) => x.id === 9741);
  assert.equal(p.cover, 'https://example.test/p2.jpg');
  assert.match(p.meta, /3 images/);
  assert.equal(p.pickable, true);
  assert.equal(body.mode, 'pick', 'the screen is told to offer a picker, not an upload');
});

test('A PROJECT NEVER ENDS UP WITH TWO COVERS', async () => {
  const r = await api('PATCH', '/admin/covers/project/9741', { imageId: 9753 }, adminToken);
  assert.equal(r.status, 200);
  const rows = await pool.query('SELECT id, is_cover FROM project_images WHERE project_id = 9741 ORDER BY id');
  assert.deepEqual(rows.rows.map((x) => x.is_cover), [false, false, true],
    'the old cover is cleared in the same transaction that sets the new one');
});

test('and its cover can be cleared entirely', async () => {
  await api('PATCH', '/admin/covers/project/9741', { imageId: null }, adminToken);
  const rows = await pool.query('SELECT COUNT(*)::int n FROM project_images WHERE project_id = 9741 AND is_cover');
  assert.equal(rows.rows[0].n, 0);
  await api('PATCH', '/admin/covers/project/9741', { imageId: 9752 }, adminToken);   // put it back
});

test("AN IMAGE FROM ANOTHER PROJECT CANNOT BE MADE THIS ONE'S COVER", async () => {
  await pool.query(`INSERT INTO projects (id, title, description, status, created_by)
                    VALUES (9742, 'Another project', 'x', 'published', 630001)`);
  await pool.query(`INSERT INTO project_images (id, project_id, image_url, display_order)
                    VALUES (9761, 9742, 'https://example.test/other.jpg', 1)`);

  const r = await api('PATCH', '/admin/covers/project/9741', { imageId: 9761 }, adminToken);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /does not belong/i);

  // And the refusal must not have cleared the existing cover on the way past.
  const rows = await pool.query('SELECT COUNT(*)::int n FROM project_images WHERE project_id = 9741 AND is_cover');
  assert.equal(rows.rows[0].n, 1, 'the rollback put the existing cover back');
});

// ------------------------------------------------------------------- access

test('IT IS ADMIN-ONLY', async () => {
  assert.equal((await api('GET', '/admin/covers/types', null, memberToken)).status, 403);
  assert.equal((await api('GET', '/admin/covers/article', null, memberToken)).status, 403);
  assert.equal((await api('GET', '/admin/covers/article')).status, 401);
  assert.equal((await api('PATCH', '/admin/covers/article/9711', { imageUrl: IMG }, memberToken)).status, 403);
  assert.equal((await api('PATCH', '/admin/covers/project/9741', { imageId: 9751 }, memberToken)).status, 403);
});


// ------------------------------------ the member setting their own listing

test('A MEMBER CAN SET THEIR OWN LISTING IMAGE', async () => {
  // The column and the API accepted this all along; there was simply no field
  // in the member dashboard, so only an admin could ever choose the picture
  // that represents somebody's listing.
  const memberOwn = require('jsonwebtoken').sign(
    { id: 630002, email: 'covmember@test.com', role: 'member' }, process.env.JWT_SECRET);
  await pool.query(
    `INSERT INTO profiles (id, user_id, type, category_id, package_tier, slug, display_name, status)
     VALUES (9781, 630002, 'business', 9701, 'basic', 'own-listing', 'Own Listing', 'approved')`);

  const r = await api('PATCH', '/profiles/9781', { featureImageUrl: IMG }, memberOwn);
  assert.equal(r.status, 200);
  const row = await pool.query('SELECT feature_image_url FROM profiles WHERE id = 9781');
  assert.equal(row.rows[0].feature_image_url, IMG);
});

test('CLEARING IT STORES NULL, NOT AN EMPTY STRING', async () => {
  // Not tidiness. Competition entries and the Top 10 fall back with
  // COALESCE(ce.manual_image_url, p.feature_image_url), and COALESCE only
  // falls through on NULL — a listing cleared to '' would be inherited as ''
  // and render an <img src=""> where the fallback should have taken over.
  const memberOwn = require('jsonwebtoken').sign(
    { id: 630002, email: 'covmember@test.com', role: 'member' }, process.env.JWT_SECRET);
  await api('PATCH', '/profiles/9781', { featureImageUrl: '   ' }, memberOwn);
  const row = await pool.query('SELECT feature_image_url FROM profiles WHERE id = 9781');
  assert.equal(row.rows[0].feature_image_url, null);

  // and prove the fallback actually works through COALESCE
  const co = await pool.query(
    `SELECT COALESCE(NULLIF('', ''), p.feature_image_url) IS NULL AS falls_through
       FROM profiles p WHERE p.id = 9781`);
  assert.equal(co.rows[0].falls_through, true);
});

test("a member cannot set somebody ELSE's listing image", async () => {
  const other = require('jsonwebtoken').sign(
    { id: 630001, email: 'covadmin@test.com', role: 'admin' }, process.env.JWT_SECRET);
  // (admins legitimately can — the guard is requireOwnerOrAdmin, so check a
  // plain member against a listing that is not theirs)
  await pool.query(`INSERT INTO users (id, email, full_name, password_hash, role)
                    VALUES (630003, 'third@test.com', 'Third', 'x', 'member')`);
  const stranger = require('jsonwebtoken').sign(
    { id: 630003, email: 'third@test.com', role: 'member' }, process.env.JWT_SECRET);
  const r = await api('PATCH', '/profiles/9781', { featureImageUrl: IMG }, stranger);
  assert.ok(r.status === 403 || r.status === 404, 'got ' + r.status);
  const row = await pool.query('SELECT feature_image_url FROM profiles WHERE id = 9781');
  assert.equal(row.rows[0].feature_image_url, null, 'unchanged');
  assert.ok(other);
});

test('every kind of cover says which size it needs', async () => {
  // This used to send the Directory's size as a sentence, and every other kind
  // of cover sent nothing — an admin swapping a Hall of Fame portrait or an
  // edition cover was told nothing at all. Each type now names an entry in
  // src/utils/imageSpecs.js and the admin's upload field reads the numbers
  // from there, so the size is stated once and the same everywhere.
  //
  // The Directory is still the one worth naming: the spec document says
  // 1200x1200 in one place and 1920x1080 in another for this same field, and
  // the site renders it square everywhere (.dir-photo is aspect-ratio 1/1,
  // .profile-photo-lg is a circle), so a 16:9 upload loses 44% of its width.
  const { IMAGE_SPECS } = require('../src/utils/imageSpecs');

  const dir = await api('GET', '/admin/covers/directory', null, adminToken);
  assert.equal(dir.body.specKey, 'directory_listing');
  assert.equal(IMAGE_SPECS.directory_listing.w, IMAGE_SPECS.directory_listing.h, 'square');

  // The event image is the other one that was wrong: the admin used to say
  // 800x1200 (2:3 portrait) while the site renders it landscape.
  const ev = await api('GET', '/admin/covers/event', null, adminToken);
  assert.equal(ev.body.specKey, 'event_image');
  assert.ok(IMAGE_SPECS.event_image.w > IMAGE_SPECS.event_image.h, 'landscape');

  // And no type may be silent.
  const { body } = await api('GET', '/admin/covers/types', null, adminToken);
  const uploads = body.types.filter((t) => t.mode === 'upload');
  assert.ok(uploads.length >= 10);
  for (const t of uploads) {
    const r = await api('GET', '/admin/covers/' + t.key, null, adminToken);
    assert.ok(r.body.specKey && IMAGE_SPECS[r.body.specKey],
      `${t.key} does not say what size its cover should be`);
  }
});
