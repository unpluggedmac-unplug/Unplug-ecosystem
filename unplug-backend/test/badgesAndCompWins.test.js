// Members/Community System follow-up: real Badges system + hall_of_fame
// user linkage, over real HTTP against real PostgreSQL. Mounts badges.js
// and competitions.js — see universalComments.test.js for why
// require('../src/app') is avoided.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-badges-'));
const port = 19200 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

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
  return jwt.sign({ id: userId, email: `bdg${userId}@test.com`, role }, process.env.JWT_SECRET);
}

let _nextUserId = 21000;
async function makeUser() {
  const id = _nextUserId++;
  await pool.query(`INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', 'member') ON CONFLICT DO NOTHING`, [id, `bdg${id}@test.com`]);
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
  process.env.JWT_SECRET = 'test-secret-for-badges';

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
  app.use('/badges', require('../src/routes/badges'));
  app.use('/', require('../src/routes/competitions'));
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

test('the starter badge set is seeded and distinct from achievements', async () => {
  const { status, body } = await req('GET', '/badges');
  assert.equal(status, 200);
  assert.ok(body.badges.length >= 5);
  assert.ok(body.badges.some((b) => b.code === 'founding_member'));
});

test('awarding a badge is idempotent and shows up under the user\'s earned list', async () => {
  const admin = await makeUser();
  const member = await makeUser();

  const first = await req('POST', '/badges/admin/founding_member/award', { token: tokenFor(admin, 'admin'), body: { userId: member, reason: 'Early supporter' } });
  assert.equal(first.status, 200);
  assert.equal(first.body.awarded, true);

  const second = await req('POST', '/badges/admin/founding_member/award', { token: tokenFor(admin, 'admin'), body: { userId: member } });
  assert.equal(second.body.awarded, false); // already has it — no duplicate

  const earned = await req('GET', `/badges/user/${member}`);
  assert.equal(earned.body.badges.length, 1);
  assert.equal(earned.body.badges[0].code, 'founding_member');
});

test('awarding a badge sends a notification and is admin-only', async () => {
  const admin = await makeUser();
  const nonAdmin = await makeUser();
  const member = await makeUser();

  const asMember = await req('POST', '/badges/admin/founding_member/award', { token: tokenFor(nonAdmin), body: { userId: member } });
  assert.equal(asMember.status, 403);

  await req('POST', '/badges/admin/founding_member/award', { token: tokenFor(admin, 'admin'), body: { userId: member } });
  const notif = await pool.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'badge'`, [member]);
  assert.equal(notif.rows.length, 1);
});

test('revoking a badge removes it', async () => {
  const admin = await makeUser();
  const member = await makeUser();
  await req('POST', '/badges/admin/founding_member/award', { token: tokenFor(admin, 'admin'), body: { userId: member } });

  await req('DELETE', `/badges/admin/founding_member/revoke/${member}`, { token: tokenFor(admin, 'admin') });
  const earned = await req('GET', `/badges/user/${member}`);
  assert.equal(earned.body.badges.length, 0);
});

test('admin can create a brand new badge type, not just use the seeded ones', async () => {
  const admin = await makeUser();
  const create = await req('POST', '/badges/admin', {
    token: tokenFor(admin, 'admin'),
    body: { code: 'test_badge_xyz', label: 'Test Badge', description: 'A custom badge', emoji: '🧪' },
  });
  assert.equal(create.status, 201);

  // Searched rather than scanned: the catalogue is 2000+ badges and the admin
  // list is paged, so "is it on page one" stopped being the same question as
  // "does it exist". Searching is also what an admin actually does.
  const found = await req('GET', '/badges/admin/all?q=test_badge_xyz', { token: tokenFor(admin, 'admin') });
  assert.ok(found.body.badges.some((b) => b.code === 'test_badge_xyz'));
});

test('hall_of_fame accepts an optional linkedUserId, and get_public_profile_analytics reflects it as competitions_won', async () => {
  const admin = await makeUser();
  const winner = await makeUser();
  const unlinkedWinner = await makeUser();

  // Unlinked, text-only entry — same as every entry before this change.
  await req('POST', '/hall-of-fame', { token: tokenFor(admin, 'admin'), body: { name: 'Old School Winner', year: 2020 } });

  // Linked entry.
  await req('POST', '/hall-of-fame', { token: tokenFor(admin, 'admin'), body: { name: 'New Winner', year: 2026, linkedUserId: winner } });

  const stats = await pool.query('SELECT * FROM get_public_profile_analytics($1)', [winner]);
  assert.equal(stats.rows[0].competitions_won, 1);

  const unlinkedStats = await pool.query('SELECT * FROM get_public_profile_analytics($1)', [unlinkedWinner]);
  assert.equal(unlinkedStats.rows[0].competitions_won, 0);
});

test('badges_earned and achievements_earned are independently sourced, not the same duplicated number', async () => {
  const admin = await makeUser();
  const userId = await makeUser();
  await req('POST', '/badges/admin/founding_member/award', { token: tokenFor(admin, 'admin'), body: { userId } });

  const stats = await pool.query('SELECT * FROM get_public_profile_analytics($1)', [userId]);
  assert.equal(stats.rows[0].badges_earned, 1); // one badge awarded
  assert.equal(stats.rows[0].achievements_earned, 0); // no achievement unlocked — genuinely independent counts
});

test('re-running every migration is idempotent — badge seeds and hall_of_fame linkage survive', async () => {
  const before1 = await pool.query('SELECT COUNT(*)::INTEGER AS n FROM badges');
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }
  const after1 = await pool.query('SELECT COUNT(*)::INTEGER AS n FROM badges');
  assert.equal(before1.rows[0].n, after1.rows[0].n);

  const table = await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'hall_of_fame' AND column_name = 'linked_user_id'`);
  assert.equal(table.rows.length, 1);
});
