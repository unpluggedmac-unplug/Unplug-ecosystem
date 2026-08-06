// Members, Profile Social Interaction & Community System — Phase 4:
// Follow / Unfollow System, over real HTTP against real PostgreSQL.
// Mounts only follows.js on a bare Express app (NOT require('../src/app'),
// which starts a real server + the participation scheduler's setInterval
// timers unconditionally and hangs the test process — see the comment in
// universalComments.test.js for how that was diagnosed).
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-follows-'));
const port = 16800 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

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
  return jwt.sign({ id: userId, email: `follow${userId}@test.com`, role }, process.env.JWT_SECRET);
}

let _nextUserId = 16000;
async function makeUser() {
  const id = _nextUserId++;
  await pool.query(`INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', 'member') ON CONFLICT DO NOTHING`, [id, `follow${id}@test.com`]);
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
  process.env.JWT_SECRET = 'test-secret-for-follows';

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
  app.use('/follows', require('../src/routes/follows'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await pool.end();
  await pg.stop();
});

test('following a member creates the relationship and updates both counts', async () => {
  const a = await makeUser();
  const b = await makeUser();

  const { status, body } = await req('POST', `/follows/${b}`, { token: tokenFor(a) });
  assert.equal(status, 201);
  assert.equal(body.following, true);

  const countsB = await req('GET', `/follows/${b}/counts`);
  const countsA = await req('GET', `/follows/${a}/counts`);
  assert.equal(countsB.body.followers, 1);
  assert.equal(countsA.body.following, 1);
});

test('following twice is idempotent — count stays at 1, not 2', async () => {
  const a = await makeUser();
  const b = await makeUser();
  await req('POST', `/follows/${b}`, { token: tokenFor(a) });
  const second = await req('POST', `/follows/${b}`, { token: tokenFor(a) });
  assert.equal(second.status, 201);
  assert.equal(second.body.wasAlreadyFollowing, true);

  const counts = await req('GET', `/follows/${b}/counts`);
  assert.equal(counts.body.followers, 1);
});

test('a user cannot follow themselves', async () => {
  const a = await makeUser();
  const { status, body } = await req('POST', `/follows/${a}`, { token: tokenFor(a) });
  assert.equal(status, 400);
  assert.match(body.error, /cannot follow yourself/);
});

test('unfollowing removes the relationship and the count drops back to 0', async () => {
  const a = await makeUser();
  const b = await makeUser();
  await req('POST', `/follows/${b}`, { token: tokenFor(a) });
  const unfollow = await req('DELETE', `/follows/${b}`, { token: tokenFor(a) });
  assert.equal(unfollow.status, 200);
  assert.equal(unfollow.body.following, false);

  const counts = await req('GET', `/follows/${b}/counts`);
  assert.equal(counts.body.followers, 0);
});

test('following awards the followed member points and a notification, only once per follower', async () => {
  const a = await makeUser();
  const b = await makeUser();
  await req('POST', `/follows/${b}`, { token: tokenFor(a) });

  const points = await pool.query(
    `SELECT total_points FROM participation_points WHERE user_id = $1 AND action_code = 'follow_received'`, [b]
  );
  assert.equal(points.rows.length, 1);
  assert.equal(points.rows[0].total_points, 5);

  const notif = await pool.query(`SELECT 1 AS found FROM notifications WHERE user_id = $1 AND type = 'follow'`, [b]);
  assert.equal(notif.rows.length, 1);

  // Unfollow then re-follow the same person — object_action_tracker
  // (unique_per_object on follow_received) must block a second award for
  // the same follower, closing the follow/unfollow/follow points-farming
  // loop.
  await req('DELETE', `/follows/${b}`, { token: tokenFor(a) });
  await req('POST', `/follows/${b}`, { token: tokenFor(a) });
  const pointsAfter = await pool.query(
    `SELECT COUNT(*)::INTEGER AS n FROM participation_points WHERE user_id = $1 AND action_code = 'follow_received'`, [b]
  );
  assert.equal(pointsAfter.rows[0].n, 1); // still just the one award
});

test('GET /follows/:userId/followers and /following list the right people', async () => {
  const a = await makeUser();
  const b = await makeUser();
  const c = await makeUser();
  await req('POST', `/follows/${c}`, { token: tokenFor(a) });
  await req('POST', `/follows/${c}`, { token: tokenFor(b) });

  const followers = await req('GET', `/follows/${c}/followers`);
  assert.equal(followers.body.followers.length, 2);
  const followerIds = followers.body.followers.map((f) => f.user_id).sort((x, y) => x - y);
  assert.deepEqual(followerIds, [a, b].sort((x, y) => x - y));

  const following = await req('GET', `/follows/${a}/following`);
  assert.equal(following.body.following.length, 1);
  assert.equal(following.body.following[0].user_id, c);
});

test('GET /follows/:userId/mine reports the signed-in member\'s own follow state', async () => {
  const a = await makeUser();
  const b = await makeUser();
  const before1 = await req('GET', `/follows/${b}/mine`, { token: tokenFor(a) });
  assert.equal(before1.body.following, false);

  await req('POST', `/follows/${b}`, { token: tokenFor(a) });
  const after1 = await req('GET', `/follows/${b}/mine`, { token: tokenFor(a) });
  assert.equal(after1.body.following, true);
});
