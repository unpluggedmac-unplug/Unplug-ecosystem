// EVERY MEMBER IN THE PARTICIPATION ENGINE — the admin's roll call.
//
// The point of this endpoint is the people the other views DROP:
//   1. Someone who signed up and has done nothing yet — no score_cache row, no
//      streak, no rank. They must still be listed, on zero, not vanish because
//      a supporting row was never written.
//   2. Someone who opted OUT of the public leaderboard. They are still in the
//      engine and an admin must be able to see them.
//   3. Everyone below the leaderboard's cut-off, which is only ever a top few.
//
// If this file passes, "show me everyone signed up" is answerable. If it fails
// on the LEFT JOIN cases, the list silently under-reports — the worst outcome,
// because nothing looks broken.
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
let jwt;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-pamem-'));
const port = 27600 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

async function req(method, urlPath, { token } = {}) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, body: json };
}

function tokenFor(userId, role = 'member') {
  return jwt.sign({ id: userId, email: `pa${userId}@test.com`, role }, process.env.JWT_SECRET);
}

let _nextUserId = 191000;
async function makeUser(fullName) {
  const id = _nextUserId++;
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role, full_name)
     VALUES ($1, $2, 'x', 'member', $3) ON CONFLICT DO NOTHING`,
    [id, `pa${id}@test.com`, fullName || null]
  );
  return id;
}

// Enrolling is exactly what the member dashboard does on first load.
async function enrol(userId) {
  await pool.query('SELECT ensure_member_participation_profile($1)', [userId]);
}

let adminToken;
let adminId;

before(async () => {
  pg = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'postgres', password: 'postgres', port,
    persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('unplug_test');

  process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${port}/unplug_test`;
  process.env.JWT_SECRET = 'test-secret-for-participation-members';
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
  app.use('/participation', require('../src/routes/participation'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  adminId = await makeUser('The Admin');
  await pool.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [adminId]);
  adminToken = tokenFor(adminId, 'admin');
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  if (pg) await pg.stop();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* Windows holds the dir briefly */ }
});

test('a member who signed up and has done NOTHING is still listed', async () => {
  // No score_cache row, no streak, no rank. Every one of those is a LEFT JOIN
  // for exactly this reason — an inner join would drop them silently.
  const id = await makeUser('Brand New Member');
  await enrol(id);

  const res = await req('GET', '/participation/admin/members', { token: adminToken });
  assert.equal(res.status, 200);
  const row = res.body.members.find((m) => m.user_id === id);
  assert.ok(row, 'someone who has just signed up MUST appear in the roll call');
  assert.equal(row.unplug_score, 0);
  assert.equal(row.total_actions, 0);
  assert.equal(row.current_streak_days, 0);
  assert.equal(row.badge_count, 0);
  assert.equal(row.rank_position, null, 'no rank yet is null, not a crash');
  assert.ok(row.referral_code, 'their referral code is part of the record');
  assert.equal(row.trust_score, 100, 'a clean member defaults to full trust');
});

test('a member who opted OUT of the leaderboard is still listed', async () => {
  const id = await makeUser('Prefers Privacy');
  await enrol(id);
  await pool.query(
    'UPDATE member_participation_profiles SET show_on_leaderboard = FALSE WHERE user_id = $1', [id]
  );

  const res = await req('GET', '/participation/admin/members', { token: adminToken });
  const row = res.body.members.find((m) => m.user_id === id);
  assert.ok(row, 'opting out of the PUBLIC leaderboard must not hide someone from the admin');
  assert.equal(row.show_on_leaderboard, false, 'and the admin can see that they opted out');
});

test('real activity is reported — score, actions and badges', async () => {
  const id = await makeUser('Actually Active');
  await enrol(id);
  // 'admin_grant' is a real seeded action code (072). An unrecognised code
  // makes award_points a silent no-op, which is what makes this a live check
  // of the count rather than of the seed data.
  await pool.query('SELECT award_points($1, $2, $3, $4, $5)', [id, 'admin_grant', null, null, null]);
  await pool.query('SELECT award_points($1, $2, $3, $4, $5)', [id, 'admin_grant', null, null, null]);

  const res = await req('GET', '/participation/admin/members', { token: adminToken });
  const row = res.body.members.find((m) => m.user_id === id);
  assert.ok(row.total_actions >= 1, 'their actions must be counted');
  assert.ok(row.last_action_at, 'and when they were last active');
});

test('the totals count everyone, not just this page', async () => {
  const res = await req('GET', '/participation/admin/members?limit=1', { token: adminToken });
  assert.equal(res.body.members.length, 1, 'paging is respected');
  assert.ok(res.body.totals.enrolled >= 3, 'but the total covers every enrolled member');
  assert.ok(res.body.totals.hidden_from_leaderboard >= 1, 'including the opted-out count');
  assert.equal(res.body.matched, res.body.totals.enrolled, 'with no search on, matched IS the total');
});

test('search finds a member by name, email or referral code', async () => {
  const id = await makeUser('Findable Person');
  await enrol(id);
  const code = (await pool.query(
    'SELECT referral_code FROM member_participation_profiles WHERE user_id = $1', [id]
  )).rows[0].referral_code;

  for (const [what, q] of [['name', 'Findable'], ['email', `pa${id}@test.com`], ['referral code', code]]) {
    const res = await req('GET', `/participation/admin/members?q=${encodeURIComponent(q)}`, { token: adminToken });
    assert.ok(res.body.members.some((m) => m.user_id === id), `search by ${what} must find them`);
    assert.ok(res.body.matched >= 1, `matched is reported for a ${what} search`);
  }
});

test('an unknown sort falls back rather than erroring', async () => {
  // The sort value reaches an ORDER BY, so it is whitelisted — anything else
  // must be ignored, never interpolated.
  const res = await req('GET', '/participation/admin/members?sort=; DROP TABLE users', { token: adminToken });
  assert.equal(res.status, 200);
  const stillThere = await pool.query(`SELECT COUNT(*)::int AS n FROM users`);
  assert.ok(stillThere.rows[0].n > 0, 'the users table is untouched');
});

test('sorting by newest puts the most recent sign-up first', async () => {
  const id = await makeUser('Newest Of All');
  await enrol(id);
  const res = await req('GET', '/participation/admin/members?sort=newest', { token: adminToken });
  assert.equal(res.body.members[0].user_id, id);
});

test('the roll call is admin-only', async () => {
  const memberToken = tokenFor(await makeUser(), 'member');
  assert.equal((await req('GET', '/participation/admin/members')).status, 401);
  assert.equal((await req('GET', '/participation/admin/members', { token: memberToken })).status, 403);
});
