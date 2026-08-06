// Members/Community System follow-up — the remaining admin panel gaps from
// the brief's item 11: suspend users, admin deletion of individual
// reactions/saves, and admin-configurable notification types + public
// analytics visibility (092_admin_moderation.sql). Over real HTTP against
// real PostgreSQL. See universalComments.test.js for why
// require('../src/app') is avoided.
//
// Run with:  npm test   (from unplug-backend/)

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const bcrypt = require('bcryptjs');
const EmbeddedPostgres = require('embedded-postgres').default;

let pg;
let pool;
let server;
let baseUrl;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-adminmod-'));
const port = 20000 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

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
  return jwt.sign({ id: userId, email: `adminmod${userId}@test.com`, role }, process.env.JWT_SECRET);
}

let _nextUserId = 23000;
async function makeUser(role = 'member', { password } = {}) {
  const id = _nextUserId++;
  const hash = password ? await bcrypt.hash(password, 4) : 'x';
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role, email_verified) VALUES ($1, $2, $3, $4, TRUE) ON CONFLICT DO NOTHING`,
    [id, `adminmod${id}@test.com`, hash, role]
  );
  return id;
}

let _nextArticleId = 0;
async function makeArticle(authorId) {
  const result = await pool.query(
    `INSERT INTO articles (author_user_id, title, body, status) VALUES ($1, $2, 'body', 'approved') RETURNING id`,
    [authorId, `Admin Mod Article ${_nextArticleId++}`]
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
  process.env.JWT_SECRET = 'test-secret-for-adminmod';

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
  app.use('/auth', require('../src/routes/auth'));
  app.use('/admin', require('../src/routes/admin'));
  app.use('/interactions', require('../src/routes/interactions'));
  app.use('/profile-analytics', require('../src/routes/profileAnalytics'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await pool.end();
  await pg.stop();
});

test('a suspended account cannot log in, even with the correct password, and sees the suspension reason', async () => {
  const admin = await makeUser('admin');
  const member = await makeUser('member', { password: 'correct-horse-battery' });

  const before1 = await req('POST', '/auth/login', { body: { email: `adminmod${member}@test.com`, password: 'correct-horse-battery' } });
  assert.equal(before1.status, 200);

  await req('PATCH', `/admin/users/${member}`, { token: tokenFor(admin, 'admin'), body: { isSuspended: true, suspendedReason: 'Reported for spam' } });

  const after1 = await req('POST', '/auth/login', { body: { email: `adminmod${member}@test.com`, password: 'correct-horse-battery' } });
  assert.equal(after1.status, 403);
  assert.match(after1.body.error, /Reported for spam/);

  await req('PATCH', `/admin/users/${member}`, { token: tokenFor(admin, 'admin'), body: { isSuspended: false } });
  const restored = await req('POST', '/auth/login', { body: { email: `adminmod${member}@test.com`, password: 'correct-horse-battery' } });
  assert.equal(restored.status, 200);
});

test('an admin cannot suspend the account they are signed in with', async () => {
  const admin = await makeUser('admin');
  const { status, body } = await req('PATCH', `/admin/users/${admin}`, { token: tokenFor(admin, 'admin'), body: { isSuspended: true } });
  assert.equal(status, 400);
  assert.match(body.error, /cannot suspend/);
});

test('a non-admin cannot suspend anyone', async () => {
  const member = await makeUser();
  const other = await makeUser();
  const { status } = await req('PATCH', `/admin/users/${other}`, { token: tokenFor(member), body: { isSuspended: true } });
  assert.equal(status, 403);
});

test('admin can look up every reaction and save on a target, then delete one of each', async () => {
  const admin = await makeUser('admin');
  const author = await makeUser();
  const liker = await makeUser();
  const saver = await makeUser();
  const articleId = await makeArticle(author);

  await req('POST', `/interactions/article/${articleId}/react`, { token: tokenFor(liker), body: { reaction: 'like' } });
  await req('POST', `/interactions/article/${articleId}/save`, { token: tokenFor(saver) });

  const list = await req('GET', `/admin/interactions/article/${articleId}`, { token: tokenFor(admin, 'admin') });
  assert.equal(list.status, 200);
  assert.equal(list.body.reactions.length, 1);
  assert.equal(list.body.saves.length, 1);
  const reactionId = list.body.reactions[0].id;
  const saveId = list.body.saves[0].id;

  const delReaction = await req('DELETE', `/admin/interactions/reactions/${reactionId}`, { token: tokenFor(admin, 'admin') });
  assert.equal(delReaction.status, 200);
  const delSave = await req('DELETE', `/admin/interactions/saves/${saveId}`, { token: tokenFor(admin, 'admin') });
  assert.equal(delSave.status, 200);

  const stats = await req('GET', `/interactions/article/${articleId}/stats`);
  assert.equal(stats.body.likes, 0);
  assert.equal(stats.body.saves, 0);
});

test('a non-admin cannot browse or delete interactions through the moderation routes', async () => {
  const member = await makeUser();
  const list = await req('GET', '/admin/interactions/article/1', { token: tokenFor(member) });
  assert.equal(list.status, 403);
  const del = await req('DELETE', '/admin/interactions/reactions/1', { token: tokenFor(member) });
  assert.equal(del.status, 403);
});

test('disabling notify_profile_interaction_enabled stops the profile-interaction notification without blocking the like itself', async () => {
  const owner = await makeUser();
  const liker = await makeUser();
  const profile = await pool.query(
    `INSERT INTO profiles (user_id, type, package_tier, slug, display_name, status) VALUES ($1, 'individual', 'basic', $2, $2, 'approved') RETURNING id`,
    [owner, `adminmod-profile-${owner}`]
  );
  const profileId = profile.rows[0].id;

  await pool.query(`UPDATE settings SET value = 'false' WHERE key = 'notify_profile_interaction_enabled'`);
  const react = await req('POST', `/interactions/profile/${profileId}/react`, { token: tokenFor(liker), body: { reaction: 'like' } });
  assert.equal(react.status, 201); // the like itself still works

  const notif = await pool.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'profile_interaction'`, [owner]);
  assert.equal(notif.rows.length, 0);

  await pool.query(`UPDATE settings SET value = 'true' WHERE key = 'notify_profile_interaction_enabled'`);
});

test('disabling public_analytics_visible makes the public analytics endpoint report { visible: false } instead of the real data', async () => {
  const someone = await makeUser();

  const on = await req('GET', `/profile-analytics/${someone}/public`);
  assert.equal(on.body.visible, true);
  assert.ok('unplug_score' in on.body);

  await pool.query(`UPDATE settings SET value = 'false' WHERE key = 'public_analytics_visible'`);
  const off = await req('GET', `/profile-analytics/${someone}/public`);
  assert.deepEqual(off.body, { visible: false });
  await pool.query(`UPDATE settings SET value = 'true' WHERE key = 'public_analytics_visible'`);
});

test('re-running every migration is idempotent — suspension columns and the new settings keys survive', async () => {
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }
  const col = await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'is_suspended'`);
  assert.equal(col.rows.length, 1);
  const keys = await pool.query(`SELECT COUNT(*)::int AS n FROM settings WHERE key IN ('notify_profile_interaction_enabled', 'notify_follow_enabled', 'notify_badge_enabled', 'public_analytics_visible')`);
  assert.equal(keys.rows[0].n, 4);
});
