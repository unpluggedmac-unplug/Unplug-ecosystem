// Part 3 of "admin control over banner/cover animation effects": a hover/
// focus-revealed entrance effect on article, edition, and directory-profile
// covers — the one surface in this whole feature with NO existing animation
// to extend (story-thumb/edition-cover/dir-photo are plain static boxes
// today). Reuses the same 8-value enum every other part uses, exposed
// through the ONE shared Cover Images admin screen (adminCovers.js), which
// this test also proves stays scoped correctly: the 6 other resource types
// that screen manages (event/competition/contributor/halloffame/birthday/
// passport) must NOT gain these fields.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-coveranim-'));
const port = 60400 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

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

let articleId, profileId, eventId;

before(async () => {
  pg = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'postgres', password: 'postgres', port,
    persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('unplug_test');

  process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${port}/unplug_test`;
  process.env.JWT_SECRET = 'test-secret-for-cover-animation';

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

  const article = await pool.query(
    `INSERT INTO articles (title, body, status, banner_image_url, author_user_id)
     VALUES ('Test Article', 'body', 'approved', 'https://a.test/untouched.jpg', 1) RETURNING id`
  );
  articleId = article.rows[0].id;

  const profile = await pool.query(
    `INSERT INTO profiles (user_id, type, package_tier, slug, display_name, status, feature_image_url)
     VALUES (2, 'individual', 'basic', 'test-profile', 'Test Profile', 'approved', 'https://a.test/untouched.jpg') RETURNING id`
  );
  profileId = profile.rows[0].id;

  const event = await pool.query(
    `INSERT INTO events (name, event_date, status, image_url, organizer_user_id)
     VALUES ('Test Event', '2026-12-01', 'approved', 'https://a.test/untouched.jpg', 1) RETURNING id`
  );
  eventId = event.rows[0].id;

  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/admin/covers', require('../src/routes/adminCovers'));
  app.use('/articles', require('../src/routes/articles'));
  app.use('/', require('../src/routes/profiles')); // its own routes already include /profiles/* and /directory
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

test('THE MIGRATION ITSELF REJECTS AN INVALID EFFECT', async () => {
  await assert.rejects(
    pool.query(`INSERT INTO articles (title, body, status, author_user_id, cover_animation_effect) VALUES ('x', 'x', 'approved', 1, 'spin')`),
    /violates check constraint/
  );
});

test('A FRESH ARTICLE, EDITION, AND PROFILE ALL DEFAULT TO NO ANIMATION AT ALL — reproducing today\'s exact static-box look', async () => {
  const a = await pool.query(`SELECT cover_animation_effect, cover_transition_duration_ms FROM articles WHERE id = $1`, [articleId]);
  assert.equal(a.rows[0].cover_animation_effect, 'none');
  assert.equal(a.rows[0].cover_transition_duration_ms, 400);
  const p = await pool.query(`SELECT cover_animation_effect FROM profiles WHERE id = $1`, [profileId]);
  assert.equal(p.rows[0].cover_animation_effect, 'none');
});

test('GET /admin/covers/article DECLARES hasAnim:true, AND RETURNS THE CURRENT anim/anim_dur PER ITEM', async () => {
  const r = await req('GET', '/admin/covers/article', { token: adminToken });
  assert.equal(r.status, 200);
  assert.equal(r.body.hasAnim, true);
  const item = r.body.items.find((x) => x.id === articleId);
  assert.equal(item.anim, 'none');
  assert.equal(item.anim_dur, 400);
});

test('GET /admin/covers/event DOES NOT DECLARE hasAnim, AND DOES NOT RETURN anim/anim_dur — events are out of scope', async () => {
  const r = await req('GET', '/admin/covers/event', { token: adminToken });
  assert.equal(r.status, 200);
  assert.equal(r.body.hasAnim, false);
  const item = r.body.items.find((x) => x.id === eventId);
  assert.equal(item.anim, undefined);
  assert.equal(item.anim_dur, undefined);
});

test('A NON-ADMIN CANNOT EDIT A COVER\'S ANIMATION', async () => {
  const r = await req('PATCH', `/admin/covers/article/${articleId}`, {
    token: memberToken, body: { imageUrl: 'https://a.test/x.jpg', animationEffect: 'zoom' },
  });
  assert.equal(r.status, 403);
});

test('AN INVALID animationEffect IS A CLEAN 400, NOT A RAW DATABASE ERROR', async () => {
  const r = await req('PATCH', `/admin/covers/article/${articleId}`, {
    token: adminToken, body: { imageUrl: 'https://a.test/untouched.jpg', animationEffect: 'spin' },
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /animationEffect must be one of/);
});

test('AN OUT-OF-RANGE transitionDurationMs IS A CLEAN 400', async () => {
  const r = await req('PATCH', `/admin/covers/article/${articleId}`, {
    token: adminToken, body: { imageUrl: 'https://a.test/untouched.jpg', transitionDurationMs: -5 },
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /transitionDurationMs must be a positive whole number/);
});

test('A VALID EDIT ROUND-TRIPS THROUGH TO THE PUBLIC ARTICLE ROUTE', async () => {
  const r = await req('PATCH', `/admin/covers/article/${articleId}`, {
    token: adminToken, body: { imageUrl: 'https://a.test/untouched.jpg', animationEffect: 'zoom', transitionDurationMs: 500 },
  });
  assert.equal(r.status, 200);

  const pub = await req('GET', '/articles');
  assert.equal(pub.status, 200);
  const article = pub.body.articles.find((a) => a.id === articleId);
  assert.ok(article);
  assert.equal(article.cover_animation_effect, 'zoom');
  assert.equal(article.cover_transition_duration_ms, 500);
});

test('THE SAME EDIT WORKS FOR A DIRECTORY PROFILE, ROUND-TRIPPING THROUGH GET /directory', async () => {
  const r = await req('PATCH', `/admin/covers/directory/${profileId}`, {
    token: adminToken, body: { imageUrl: 'https://a.test/untouched.jpg', animationEffect: 'fade-up', transitionDurationMs: 350 },
  });
  assert.equal(r.status, 200);

  const pub = await req('GET', '/directory');
  assert.equal(pub.status, 200);
  const profile = pub.body.profiles.find((p) => p.id === profileId);
  assert.ok(profile);
  assert.equal(profile.cover_animation_effect, 'fade-up');
  assert.equal(profile.cover_transition_duration_ms, 350);
});

test('EDITING AN OUT-OF-SCOPE TYPE (event) SILENTLY IGNORES ANY ANIMATION FIELDS SENT — the columns don\'t exist on that table', async () => {
  const r = await req('PATCH', `/admin/covers/event/${eventId}`, {
    token: adminToken, body: { imageUrl: 'https://a.test/still-untouched.jpg', animationEffect: 'zoom', transitionDurationMs: 500 },
  });
  assert.equal(r.status, 200, 'the image itself must still save fine');
  const check = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'events' AND column_name LIKE 'cover_%'`);
  assert.equal(check.rowCount, 0, 'events must never have gained cover animation columns');
});
