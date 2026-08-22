// Members, Profile Social Interaction & Community System — Phase 5:
// the Members page, over real HTTP against real PostgreSQL. Mounts
// only members.js on a bare Express app — see universalComments.test.js
// for why require('../src/app') is avoided in this test suite.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-memberspage-'));
const port = 17200 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

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

let _nextUserId = 17000;
async function makeUser() {
  const id = _nextUserId++;
  await pool.query(`INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', 'member') ON CONFLICT DO NOTHING`, [id, `mp${id}@test.com`]);
  return id;
}

let _nextSlug = 0;
async function makeProfile(userId, { type = 'individual', displayName, province, isFeatured = false } = {}) {
  const slug = `mp-profile-${_nextSlug++}`;
  const result = await pool.query(
    `INSERT INTO profiles (user_id, type, package_tier, slug, display_name, status, province, is_featured)
     VALUES ($1, $2, 'basic', $3, $4, 'approved', $5, $6) RETURNING id`,
    [userId, type, slug, displayName || slug, province || null, isFeatured]
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
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/members', require('../src/routes/members'));
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

test('lists only approved profiles — a pending one never appears', async () => {
  const approvedUser = await makeUser();
  await makeProfile(approvedUser, { displayName: 'Approved Member' });
  const pendingUser = await makeUser();
  await pool.query(
    `INSERT INTO profiles (user_id, type, package_tier, slug, display_name, status)
     VALUES ($1, 'individual', 'basic', 'pending-mp', 'Pending Member', 'pending')`,
    [pendingUser]
  );

  const { status, body } = await req('GET', '/members');
  assert.equal(status, 200);
  const names = body.members.map((m) => m.display_name);
  assert.ok(names.includes('Approved Member'));
  assert.ok(!names.includes('Pending Member'));
});

test('type filter separates individual and business listings', async () => {
  const u1 = await makeUser();
  await makeProfile(u1, { type: 'individual', displayName: 'Solo Person' });
  const u2 = await makeUser();
  await makeProfile(u2, { type: 'business', displayName: 'A Real Business' });

  const businesses = await req('GET', '/members?type=business');
  const names = businesses.body.members.map((m) => m.display_name);
  assert.ok(names.includes('A Real Business'));
  assert.ok(!names.includes('Solo Person'));
});

test('province filter only returns members in that province', async () => {
  const u1 = await makeUser();
  await makeProfile(u1, { province: 'Gauteng', displayName: 'Gauteng Member' });
  const u2 = await makeUser();
  await makeProfile(u2, { province: 'Western Cape', displayName: 'Cape Member' });

  const { body } = await req('GET', '/members?province=' + encodeURIComponent('Gauteng'));
  const names = body.members.map((m) => m.display_name);
  assert.ok(names.includes('Gauteng Member'));
  assert.ok(!names.includes('Cape Member'));
});

test('search matches display_name case-insensitively', async () => {
  const u1 = await makeUser();
  await makeProfile(u1, { displayName: 'Thandiwe Search Target' });

  const { body } = await req('GET', '/members?search=search%20target');
  assert.ok(body.members.some((m) => m.display_name === 'Thandiwe Search Target'));
});

test('sort=featured only returns members with is_featured = true', async () => {
  const u1 = await makeUser();
  await makeProfile(u1, { displayName: 'Featured One', isFeatured: true });
  const u2 = await makeUser();
  await makeProfile(u2, { displayName: 'Not Featured', isFeatured: false });

  const { body } = await req('GET', '/members?sort=featured');
  const names = body.members.map((m) => m.display_name);
  assert.ok(names.includes('Featured One'));
  assert.ok(!names.includes('Not Featured'));
});

test('sort=most_followed ranks by real follower counts from Phase 4', async () => {
  const popular = await makeUser();
  await makeProfile(popular, { displayName: 'Popular Member' });
  const quiet = await makeUser();
  await makeProfile(quiet, { displayName: 'Quiet Member' });
  const follower1 = await makeUser();
  const follower2 = await makeUser();
  await pool.query('SELECT follow_member($1, $2)', [follower1, popular]);
  await pool.query('SELECT follow_member($1, $2)', [follower2, popular]);

  const { body } = await req('GET', '/members?sort=most_followed');
  const popularRow = body.members.find((m) => m.display_name === 'Popular Member');
  const quietRow = body.members.find((m) => m.display_name === 'Quiet Member');
  assert.equal(popularRow.followers, 2);
  assert.equal(quietRow.followers, 0);
  const popularIdx = body.members.indexOf(popularRow);
  const quietIdx = body.members.indexOf(quietRow);
  assert.ok(popularIdx < quietIdx);
});

test('total_likes reflects Phase 1 profile reactions, scoped per profile', async () => {
  const owner = await makeUser();
  const profileId = await makeProfile(owner, { displayName: 'Liked Member' });
  const liker = await makeUser();
  await pool.query(`INSERT INTO content_reactions (user_id, target_type, target_id, reaction) VALUES ($1, 'profile', $2, 'like')`, [liker, profileId]);

  const { body } = await req('GET', '/members?search=Liked%20Member');
  assert.equal(body.members[0].total_likes, 1);
});

test('limit and offset support infinite scroll pagination without duplicates or gaps', async () => {
  for (let i = 0; i < 5; i++) {
    const owner = await makeUser();
    await makeProfile(owner, { displayName: `Page Member ${i}` });
  }
  const page1 = await req('GET', '/members?limit=3&offset=0&search=Page%20Member');
  const page2 = await req('GET', '/members?limit=3&offset=3&search=Page%20Member');
  assert.equal(page1.body.members.length, 3);
  assert.equal(page2.body.members.length, 2);
  const ids1 = page1.body.members.map((m) => m.profile_id);
  const ids2 = page2.body.members.map((m) => m.profile_id);
  assert.equal(ids1.filter((id) => ids2.includes(id)).length, 0); // no overlap
});
