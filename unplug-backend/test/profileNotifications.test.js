// Members, Profile Social Interaction & Community System — Phase 7:
// Profile-interaction notifications, over real HTTP against real
// PostgreSQL. Mounts interactions.js, comments.js, and reviews.js
// together (comments.js/reviews.js both require notifyProfileOwner from
// interactions.js, so all three need to be live for this test).
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-profilenotif-'));
const port = 18400 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

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
  return jwt.sign({ id: userId, email: `pn${userId}@test.com`, role }, process.env.JWT_SECRET);
}

let _nextUserId = 19000;
async function makeUser() {
  const id = _nextUserId++;
  await pool.query(`INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', 'member') ON CONFLICT DO NOTHING`, [id, `pn${id}@test.com`]);
  return id;
}

let _nextSlug = 0;
async function makeProfile(userId) {
  const slug = `pn-profile-${_nextSlug++}`;
  const result = await pool.query(
    `INSERT INTO profiles (user_id, type, package_tier, slug, display_name, status) VALUES ($1, 'individual', 'basic', $2, $2, 'approved') RETURNING id`,
    [userId, slug]
  );
  return result.rows[0].id;
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
  process.env.JWT_SECRET = 'test-secret-for-profile-notifications';

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
  app.use('/interactions', require('../src/routes/interactions'));
  app.use('/comments', require('../src/routes/comments'));
  app.use('/reviews', require('../src/routes/reviews'));
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

test('liking a profile notifies its owner, but not for a like on an article', async () => {
  const owner = await makeUser();
  const profileId = await makeProfile(owner);
  const liker = await makeUser();

  await req('POST', `/interactions/profile/${profileId}/react`, { token: tokenFor(liker), body: { reaction: 'like' } });

  const notif = await pool.query(`SELECT title, body FROM notifications WHERE user_id = $1 AND type = 'profile_interaction'`, [owner]);
  assert.equal(notif.rows.length, 1);
  assert.match(notif.rows[0].body, /liked your profile/);
});

test('liking your own profile never notifies yourself', async () => {
  const owner = await makeUser();
  const profileId = await makeProfile(owner);
  await req('POST', `/interactions/profile/${profileId}/react`, { token: tokenFor(owner), body: { reaction: 'like' } });

  const notif = await pool.query(`SELECT 1 FROM notifications WHERE user_id = $1`, [owner]);
  assert.equal(notif.rows.length, 0);
});

test('switching like -> dislike -> like on the same profile only notifies once, not on every switch', async () => {
  const owner = await makeUser();
  const profileId = await makeProfile(owner);
  const actor = await makeUser();

  await req('POST', `/interactions/profile/${profileId}/react`, { token: tokenFor(actor), body: { reaction: 'like' } });
  await req('POST', `/interactions/profile/${profileId}/react`, { token: tokenFor(actor), body: { reaction: 'dislike' } });
  await req('POST', `/interactions/profile/${profileId}/react`, { token: tokenFor(actor), body: { reaction: 'like' } });

  const notif = await pool.query(`SELECT COUNT(*)::INTEGER AS n FROM notifications WHERE user_id = $1`, [owner]);
  assert.equal(notif.rows[0].n, 1);
});

test('saving a profile notifies its owner once, not again on a repeat save', async () => {
  const owner = await makeUser();
  const profileId = await makeProfile(owner);
  const saver = await makeUser();

  await req('POST', `/interactions/profile/${profileId}/save`, { token: tokenFor(saver) });
  await req('POST', `/interactions/profile/${profileId}/save`, { token: tokenFor(saver) }); // idempotent, no-op

  const notif = await pool.query(`SELECT COUNT(*)::INTEGER AS n FROM notifications WHERE user_id = $1 AND body LIKE '%saved%'`, [owner]);
  assert.equal(notif.rows[0].n, 1);
});

test('a pending comment on a profile does not notify — only an approved one does', async () => {
  const owner = await makeUser();
  const profileId = await makeProfile(owner);
  const commenter = await makeUser();
  const admin = await makeUser();

  const post = await req('POST', `/comments/profile/${profileId}`, { token: tokenFor(commenter), body: { body: 'nice profile' } });
  assert.equal(post.status, 201);

  let notif = await pool.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND body LIKE '%commented%'`, [owner]);
  assert.equal(notif.rows.length, 0); // still pending — no notification yet

  await req('PATCH', `/comments/${post.body.comment.id}/status`, { token: tokenFor(admin, 'admin'), body: { status: 'approved' } });
  notif = await pool.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND body LIKE '%commented%'`, [owner]);
  assert.equal(notif.rows.length, 1);
});

test('an approved review notifies the profile owner', async () => {
  const owner = await makeUser();
  const profileId = await makeProfile(owner);
  const reviewer = await makeUser();
  const admin = await makeUser();

  await req('POST', `/reviews/profile/${profileId}`, { token: tokenFor(reviewer), body: { rating: 5, body: 'great!' } });
  const pending = await pool.query('SELECT id FROM profile_reviews WHERE profile_id = $1', [profileId]);
  await req('PATCH', `/reviews/${pending.rows[0].id}/status`, { token: tokenFor(admin, 'admin'), body: { status: 'approved' } });

  const notif = await pool.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND body LIKE '%reviewed%'`, [owner]);
  assert.equal(notif.rows.length, 1);
});

test('a like on an article never inserts a profile_interaction notification for anyone', async () => {
  const author = await makeUser();
  await pool.query(`INSERT INTO articles (author_user_id, title, body, status) VALUES ($1, 'A', 'b', 'approved') RETURNING id`, [author]);
  const article = await pool.query('SELECT id FROM articles ORDER BY id DESC LIMIT 1');
  const liker = await makeUser();

  const before1 = await pool.query(`SELECT COUNT(*)::INTEGER AS n FROM notifications WHERE type = 'profile_interaction'`);
  await req('POST', `/interactions/article/${article.rows[0].id}/react`, { token: tokenFor(liker), body: { reaction: 'like' } });
  const after1 = await pool.query(`SELECT COUNT(*)::INTEGER AS n FROM notifications WHERE type = 'profile_interaction'`);

  // Compared against a before/after snapshot, not an absolute 0 — earlier
  // tests in this file share the same database and already created real
  // profile_interaction notifications of their own.
  assert.equal(after1.rows[0].n, before1.rows[0].n);
});
