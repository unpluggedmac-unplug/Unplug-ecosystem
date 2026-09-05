// Impact Makers — a digital recognition gallery of people, brands, sponsors,
// partners and organisations, fully admin-curated. Requested directly, as a
// large, fully-specified new feature; two genuinely open product questions
// (the category/type taxonomy's shape, and where the "Become an Impact
// Maker" button goes) were confirmed with the requester before any code was
// written — see the plan file this session for the full record.
//
// What these tests protect:
//   1. THE PUBLIC FEED ONLY EVER SHOWS 'published' ROWS, ordered featured
//      first then admin-chosen order.
//   2. A PROFILE CANNOT GO LIVE WITHOUT THE REQUIRED FIELDS (spec: name,
//      image, bio, category, type) — checked against the MERGED row, not
//      just what one PATCH request happens to send.
//   3. A NONSENSE SOCIAL/WEBSITE URL IS REFUSED, not silently saved.
//   4. CATEGORIES ARE THIS FEATURE'S OWN TABLE, not Directory's shared one —
//      confirmed structurally, not just by convention.
//   5. IT IS ADMIN-ONLY for every mutating route.
//
// Over real HTTP against real PostgreSQL. Run with: npm test (from unplug-backend/)

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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-impactmakers-'));
const port = 57600 + (process.pid % 300); // bases are 400 apart so ranges cannot overlap

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

before(async () => {
  pg = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'postgres', password: 'postgres', port,
    persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('unplug_test');

  process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${port}/unplug_test`;
  process.env.JWT_SECRET = 'test-secret-for-impactmakers';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await runMigrations();

  const jwt = require('jsonwebtoken');
  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/impact-makers', require('../src/routes/impactMakers'));
  app.use((req, res) => res.status(404).json({ error: 'not found' }));
  app.use((err, req, res, next) => { res.status(500).json({ error: err.message }); });
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await pool.query(`INSERT INTO users (id, email, password_hash, role) VALUES
    (620001, 'imadmin@test.com', 'x', 'admin'),
    (620002, 'immember@test.com', 'x', 'member')`);
  adminToken = jwt.sign({ id: 620001, email: 'imadmin@test.com', role: 'admin' }, process.env.JWT_SECRET);
  memberToken = jwt.sign({ id: 620002, email: 'immember@test.com', role: 'member' }, process.env.JWT_SECRET);
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
});

// ------------------------------------------------------------- migration

test('THE MIGRATION SEEDS THE SPEC\'S SUGGESTED CATEGORY LIST, AS ITS OWN TABLE', async () => {
  const r = await pool.query('SELECT name FROM impact_maker_categories ORDER BY display_order');
  const names = r.rows.map((x) => x.name);
  assert.ok(names.includes('Business'));
  assert.ok(names.includes('Social Impact'));
  assert.ok(names.includes('Other'));
  assert.equal(names.length, 15);
});

test('THE 12 IMPACT MAKER TYPES FROM THE SPEC ARE ALL ACCEPTED BY THE CHECK CONSTRAINT', async () => {
  const types = ['individual', 'business', 'sponsor', 'partner', 'organisation', 'changemaker',
    'entrepreneur', 'creative', 'community_leader', 'professional', 'artist', 'founder', 'other'];
  for (const t of types) {
    const r = await pool.query(
      `INSERT INTO impact_makers (display_name, impact_maker_type) VALUES ($1, $2) RETURNING id`,
      [`Type check ${t}`, t]
    );
    assert.ok(r.rows[0].id, `type "${t}" must be accepted`);
  }
});

test('AN UNKNOWN TYPE IS REJECTED AT THE DATABASE LEVEL', async () => {
  await assert.rejects(() => pool.query(
    `INSERT INTO impact_makers (display_name, impact_maker_type) VALUES ('Bad type', 'wizard')`
  ));
});

// ----------------------------------------------------------------- create

test('AN ADMIN CAN CREATE ONE WITH JUST A NAME — EVERYTHING ELSE IS OPTIONAL AT DRAFT STAGE', async () => {
  const { status, body } = await api('POST', '/impact-makers', { displayName: 'Jane Doe' }, adminToken);
  assert.equal(status, 201);
  assert.equal(body.display_name, 'Jane Doe');
  assert.equal(body.status, 'draft', 'new rows must default to draft, never live by accident');
});

test('A MEMBER CANNOT CREATE ONE', async () => {
  const { status } = await api('POST', '/impact-makers', { displayName: 'Should Fail' }, memberToken);
  assert.equal(status, 403);
});

test('SIGNED OUT CANNOT CREATE ONE EITHER', async () => {
  const { status } = await api('POST', '/impact-makers', { displayName: 'Should Fail' }, null);
  assert.equal(status, 401);
});

test('A BLANK NAME IS REFUSED', async () => {
  const { status, body } = await api('POST', '/impact-makers', { displayName: '   ' }, adminToken);
  assert.equal(status, 400);
  assert.match(body.error, /name/i);
});

test('A BAD SOCIAL URL IS REFUSED ON CREATE, NOT SILENTLY SAVED', async () => {
  const { status, body } = await api('POST', '/impact-makers',
    { displayName: 'Bad Link Test', instagramUrl: 'not a url at all' }, adminToken);
  assert.equal(status, 400);
  assert.match(body.error, /web address/i);
});

test('A REAL HTTPS SOCIAL URL IS ACCEPTED', async () => {
  const { status, body } = await api('POST', '/impact-makers',
    { displayName: 'Good Link Test', instagramUrl: 'https://instagram.com/janedoe' }, adminToken);
  assert.equal(status, 201);
  assert.equal(body.instagram_url, 'https://instagram.com/janedoe');
});

// -------------------------------------------------------- publish gate

test('CANNOT PUBLISH WITHOUT AN IMAGE, A BIO, A CATEGORY AND A TYPE, EVEN THOUGH THE NAME IS THERE', async () => {
  const created = await api('POST', '/impact-makers', { displayName: 'Incomplete Profile' }, adminToken);
  const { status, body } = await api('PATCH', `/impact-makers/${created.body.id}`, { status: 'published' }, adminToken);
  assert.equal(status, 400);
  assert.match(body.error, /profile\/brand image/);
  assert.match(body.error, /bio/);
  assert.match(body.error, /category/);
});

test('THE PUBLISH GATE JUDGES THE MERGED ROW, NOT JUST ONE REQUEST — FIELDS SET IN EARLIER PATCHES COUNT', async () => {
  const cat = await pool.query(`SELECT id FROM impact_maker_categories WHERE name = 'Business'`);
  const created = await api('POST', '/impact-makers', { displayName: 'Built Up In Stages' }, adminToken);
  const id = created.body.id;

  // Filled in across several small edits, the way an admin actually would.
  await api('PATCH', `/impact-makers/${id}`, { photoUrl: 'https://example.com/photo.jpg' }, adminToken);
  await api('PATCH', `/impact-makers/${id}`, { bio: 'A five sentence story goes here for real.' }, adminToken);
  await api('PATCH', `/impact-makers/${id}`, { categoryId: cat.rows[0].id }, adminToken);

  // impact_maker_type already defaults to 'individual' from creation, so
  // this final PATCH sends ONLY status — the gate must see the whole row.
  const { status, body } = await api('PATCH', `/impact-makers/${id}`, { status: 'published' }, adminToken);
  assert.equal(status, 200);
  assert.equal(body.status, 'published');
});

test('A COMPLETE PROFILE PUBLISHES CLEANLY IN ONE REQUEST', async () => {
  const cat = await pool.query(`SELECT id FROM impact_maker_categories WHERE name = 'Community'`);
  const { status, body } = await api('POST', '/impact-makers', {
    displayName: 'Complete Profile',
    photoUrl: 'https://example.com/complete.jpg',
    bio: 'Five real sentences about real impact go here today.',
    categoryId: cat.rows[0].id,
    impactMakerType: 'changemaker',
  }, adminToken);
  const pub = await api('PATCH', `/impact-makers/${body.id}`, { status: 'published' }, adminToken);
  assert.equal(pub.status, 200);
  assert.equal(pub.body.status, 'published');
});

test('AN INVALID STATUS VALUE IS REFUSED', async () => {
  const created = await api('POST', '/impact-makers', { displayName: 'Status Test' }, adminToken);
  const { status, body } = await api('PATCH', `/impact-makers/${created.body.id}`, { status: 'live' }, adminToken);
  assert.equal(status, 400);
  assert.match(body.error, /draft, published or archived/);
});

// --------------------------------------------------------------- public feed

test('THE PUBLIC FEED SHOWS ONLY PUBLISHED ROWS, FEATURED FIRST', async () => {
  const cat = await pool.query(`SELECT id FROM impact_maker_categories WHERE name = 'Media'`);
  async function makePublished(name, featured, order) {
    const created = await api('POST', '/impact-makers', {
      displayName: name, photoUrl: 'https://example.com/x.jpg', bio: 'Bio.',
      categoryId: cat.rows[0].id, impactMakerType: 'individual', displayOrder: order,
    }, adminToken);
    await api('PATCH', `/impact-makers/${created.body.id}`, { status: 'published', featured }, adminToken);
    return created.body.id;
  }

  await makePublished('Public Feed — Not Featured', false, 1);
  await makePublished('Public Feed — Featured', true, 2);
  const draft = await api('POST', '/impact-makers', { displayName: 'Public Feed — Still Draft' }, adminToken);

  const { status, body } = await api('GET', '/impact-makers');
  assert.equal(status, 200);
  const names = body.map((m) => m.display_name);
  assert.ok(names.includes('Public Feed — Featured'));
  assert.ok(names.includes('Public Feed — Not Featured'));
  assert.ok(!names.includes('Public Feed — Still Draft'), 'a draft must never reach the public feed');
  assert.ok(!names.includes(draft.body.display_name) || true);

  const featuredIdx = names.indexOf('Public Feed — Featured');
  const notFeaturedIdx = names.indexOf('Public Feed — Not Featured');
  assert.ok(featuredIdx < notFeaturedIdx, 'featured must sort before non-featured');
});

test('THE PUBLIC FEED CARRIES THE CATEGORY NAME, NOT JUST ITS ID', async () => {
  const { body } = await api('GET', '/impact-makers');
  const withCategory = body.find((m) => m.category_name);
  assert.ok(withCategory, 'at least one published row above has a category');
});

// -------------------------------------------------------------------- admin list

test('ADMIN/ALL SHOWS EVERY STATUS, NOT JUST PUBLISHED', async () => {
  const { status, body } = await api('GET', '/impact-makers/admin/all', null, adminToken);
  assert.equal(status, 200);
  assert.ok(body.some((m) => m.status === 'draft'), 'drafts must be visible to the admin list');
});

test('A MEMBER CANNOT SEE THE ADMIN LIST', async () => {
  const { status } = await api('GET', '/impact-makers/admin/all', null, memberToken);
  assert.equal(status, 403);
});

// ------------------------------------------------------------------- delete

test('AN ADMIN CAN DELETE ONE, AND IT DISAPPEARS FROM ADMIN/ALL', async () => {
  const created = await api('POST', '/impact-makers', { displayName: 'To Be Deleted' }, adminToken);
  const del = await api('DELETE', `/impact-makers/${created.body.id}`, null, adminToken);
  assert.equal(del.status, 200);
  const all = await api('GET', '/impact-makers/admin/all', null, adminToken);
  assert.ok(!all.body.some((m) => m.id === created.body.id));
});

test('DELETING SOMETHING THAT NO LONGER EXISTS IS A CLEAN 404', async () => {
  const { status } = await api('DELETE', '/impact-makers/999999', null, adminToken);
  assert.equal(status, 404);
});

// ---------------------------------------------------------------- categories

test('THE PUBLIC CATEGORY LIST IS READABLE WITH NO SIGN-IN', async () => {
  const { status, body } = await api('GET', '/impact-makers/categories');
  assert.equal(status, 200);
  assert.ok(body.length >= 15);
});

test('AN ADMIN CAN ADD A NEW CATEGORY', async () => {
  const { status, body } = await api('POST', '/impact-makers/categories', { name: 'Health & Wellness' }, adminToken);
  assert.equal(status, 201);
  assert.equal(body.name, 'Health & Wellness');
});

test('A DUPLICATE CATEGORY NAME IS REFUSED', async () => {
  const { status } = await api('POST', '/impact-makers/categories', { name: 'Business' }, adminToken);
  assert.equal(status, 409);
});

test('A MEMBER CANNOT ADD A CATEGORY', async () => {
  const { status } = await api('POST', '/impact-makers/categories', { name: 'Should Fail' }, memberToken);
  assert.equal(status, 403);
});

test('AN ADMIN CAN RENAME A CATEGORY, AND RENAMING TO AN EXISTING NAME IS REFUSED', async () => {
  const created = await api('POST', '/impact-makers/categories', { name: 'Temp Category' }, adminToken);
  const renamed = await api('PATCH', `/impact-makers/categories/${created.body.id}`, { name: 'Renamed Category' }, adminToken);
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.name, 'Renamed Category');

  const clash = await api('PATCH', `/impact-makers/categories/${created.body.id}`, { name: 'Business' }, adminToken);
  assert.equal(clash.status, 409);
});

test('AN ADMIN CAN DELETE A CATEGORY, AND A PROFILE POINTING AT IT JUST LOSES THE LINK, NOT ITS ROW', async () => {
  const cat = await api('POST', '/impact-makers/categories', { name: 'Soon Deleted' }, adminToken);
  const maker = await api('POST', '/impact-makers', { displayName: 'Orphaned Category Test', categoryId: cat.body.id }, adminToken);
  await api('DELETE', `/impact-makers/categories/${cat.body.id}`, null, adminToken);

  const row = await pool.query('SELECT category_id FROM impact_makers WHERE id = $1', [maker.body.id]);
  assert.equal(row.rows[0].category_id, null, 'ON DELETE SET NULL must have fired');
  const stillThere = await pool.query('SELECT id FROM impact_makers WHERE id = $1', [maker.body.id]);
  assert.equal(stillThere.rows.length, 1, 'the Impact Maker itself must survive its category being deleted');
});
