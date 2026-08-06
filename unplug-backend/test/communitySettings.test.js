// Members, Profile Social Interaction & Community System — Phase 8:
// Admin Management (community feature toggles + feature-member), over
// real HTTP against real PostgreSQL.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-communitysettings-'));
const port = 18800 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

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
  return jwt.sign({ id: userId, email: `cs${userId}@test.com`, role }, process.env.JWT_SECRET);
}

let _nextUserId = 20000;
async function makeUser(role = 'member') {
  const id = _nextUserId++;
  await pool.query(`INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', $3) ON CONFLICT DO NOTHING`, [id, `cs${id}@test.com`, role]);
  return id;
}

let _nextSlug = 0;
async function makeProfile(userId) {
  const slug = `cs-profile-${_nextSlug++}`;
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
  process.env.JWT_SECRET = 'test-secret-for-community-settings';

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
  app.use('/follows', require('../src/routes/follows'));
  app.use('/admin', require('../src/routes/admin'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await pool.end();
  await pg.stop();
});

test('all seven community toggles exist and default to enabled', async () => {
  const rows = await pool.query(
    `SELECT key, value FROM settings WHERE key LIKE 'community_%' ORDER BY key`
  );
  assert.equal(rows.rows.length, 7);
  assert.ok(rows.rows.every((r) => r.value === 'true'));
});

test('disabling likes via the existing generic /admin/settings route blocks liking, but not disliking', async () => {
  const admin = await makeUser('admin');
  const owner = await makeUser();
  const profileId = await makeProfile(owner);
  const liker = await makeUser();

  await req('PATCH', '/admin/settings/community_likes_enabled', { token: tokenFor(admin, 'admin'), body: { value: 'false' } });

  const likeAttempt = await req('POST', `/interactions/profile/${profileId}/react`, { token: tokenFor(liker), body: { reaction: 'like' } });
  assert.equal(likeAttempt.status, 403);

  const dislikeAttempt = await req('POST', `/interactions/profile/${profileId}/react`, { token: tokenFor(liker), body: { reaction: 'dislike' } });
  assert.equal(dislikeAttempt.status, 201); // dislikes still enabled independently

  await req('PATCH', '/admin/settings/community_likes_enabled', { token: tokenFor(admin, 'admin'), body: { value: 'true' } }); // reset for later tests
});

test('disabling saves blocks POST /interactions/:type/:id/save', async () => {
  const admin = await makeUser('admin');
  const owner = await makeUser();
  const profileId = await makeProfile(owner);
  const saver = await makeUser();

  await req('PATCH', '/admin/settings/community_saves_enabled', { token: tokenFor(admin, 'admin'), body: { value: 'false' } });
  const { status } = await req('POST', `/interactions/profile/${profileId}/save`, { token: tokenFor(saver) });
  assert.equal(status, 403);

  await req('PATCH', '/admin/settings/community_saves_enabled', { token: tokenFor(admin, 'admin'), body: { value: 'true' } });
  const retry = await req('POST', `/interactions/profile/${profileId}/save`, { token: tokenFor(saver) });
  assert.equal(retry.status, 201);
});

test('disabling comments blocks new comment submission', async () => {
  const admin = await makeUser('admin');
  const owner = await makeUser();
  const profileId = await makeProfile(owner);
  const commenter = await makeUser();

  await req('PATCH', '/admin/settings/community_comments_enabled', { token: tokenFor(admin, 'admin'), body: { value: 'false' } });
  const { status } = await req('POST', `/comments/profile/${profileId}`, { token: tokenFor(commenter), body: { body: 'hello' } });
  assert.equal(status, 403);

  await req('PATCH', '/admin/settings/community_comments_enabled', { token: tokenFor(admin, 'admin'), body: { value: 'true' } });
});

test('disabling following blocks POST /follows/:userId, disabling unfollowing blocks DELETE independently', async () => {
  const admin = await makeUser('admin');
  const a = await makeUser();
  const b = await makeUser();

  await req('PATCH', '/admin/settings/community_follow_enabled', { token: tokenFor(admin, 'admin'), body: { value: 'false' } });
  const followAttempt = await req('POST', `/follows/${b}`, { token: tokenFor(a) });
  assert.equal(followAttempt.status, 403);
  await req('PATCH', '/admin/settings/community_follow_enabled', { token: tokenFor(admin, 'admin'), body: { value: 'true' } });

  await req('POST', `/follows/${b}`, { token: tokenFor(a) }); // now allowed
  await req('PATCH', '/admin/settings/community_unfollow_enabled', { token: tokenFor(admin, 'admin'), body: { value: 'false' } });
  const unfollowAttempt = await req('DELETE', `/follows/${b}`, { token: tokenFor(a) });
  assert.equal(unfollowAttempt.status, 403);
  await req('PATCH', '/admin/settings/community_unfollow_enabled', { token: tokenFor(admin, 'admin'), body: { value: 'true' } });
});

test('a missing/typo\'d settings key fails open (feature stays enabled), never silently blocks by accident', async () => {
  const { isCommunityFeatureEnabled } = require('../src/utils/communitySettings');
  const enabled = await isCommunityFeatureEnabled('community_this_key_does_not_exist');
  assert.equal(enabled, true);
});

test('PATCH /admin/profiles/:id/feature toggles is_featured, admin-only', async () => {
  const admin = await makeUser('admin');
  const member = await makeUser();
  const owner = await makeUser();
  const profileId = await makeProfile(owner);

  const asNonAdmin = await req('PATCH', `/admin/profiles/${profileId}/feature`, { token: tokenFor(member) });
  assert.equal(asNonAdmin.status, 403);

  const first = await req('PATCH', `/admin/profiles/${profileId}/feature`, { token: tokenFor(admin, 'admin') });
  assert.equal(first.status, 200);
  assert.equal(first.body.profile.is_featured, true);

  const second = await req('PATCH', `/admin/profiles/${profileId}/feature`, { token: tokenFor(admin, 'admin') });
  assert.equal(second.body.profile.is_featured, false); // toggles back off
});
