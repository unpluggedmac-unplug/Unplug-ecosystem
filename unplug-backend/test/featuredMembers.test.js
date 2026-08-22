// "Unplug Members worth checking out" — the homepage card row, against a REAL
// PostgreSQL.
//
// It replaces two plain-text lists with one row of cards, so the rules that
// matter are about what can appear on the front page:
//
//   1. EVERY CARD MUST OPEN SOMETHING. A card is a picture and a link, so only
//      people with a profile are eligible — a Directory listing for a
//      business, a My Unplug profile for an individual. Anyone with neither is
//      skipped rather than rendered as a grey box that goes nowhere;
//   2. nobody occupies two of the five places. Somebody who is both a member
//      and a business appears once;
//   3. admins are excluded, for the same reason they came off the leaderboard;
//   4. the count is an admin setting and is CLAMPED — a bad value in the
//      settings table must not put hundreds of cards on the homepage.
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
let adminToken;
let memberToken;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-featmem-'));
const port = 34800 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

async function req(method, urlPath, { token, body } = {}) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, body: json };
}

let _id = 1201000;
let _slug = 0;
async function makeUser(role = 'member') {
  const id = _id++;
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', $3)`,
    [id, `fm${id}@test.com`, role]);
  return id;
}

async function giveBusiness(userId, name) {
  await pool.query(
    `INSERT INTO profiles (user_id, type, package_tier, slug, display_name, status, feature_image_url)
     VALUES ($1, 'business', 'basic', $2, $3, 'approved', 'https://example.com/x.jpg')`,
    [userId, `fm-biz-${_slug++}`, name]);
}

async function giveMyUnplug(userId, name) {
  await pool.query(
    `INSERT INTO my_unplug_profiles (user_id, username, display_name, avatar_url)
     VALUES ($1, $2, $3, 'https://example.com/a.jpg')`,
    [userId, `fmuser${userId}`, name]);
}

async function givePoints(userId, points, daysAgo = 1) {
  const action = await pool.query('SELECT code FROM participation_actions LIMIT 1');
  if (action.rowCount === 0) return false;
  await pool.query(
    `INSERT INTO participation_points (user_id, action_code, total_points, earned_at, is_reversed)
     VALUES ($1, $2, $3, now() - ($4 || ' days')::interval, FALSE)`,
    [userId, action.rows[0].code, points, String(daysAgo)]);
  return true;
}

async function featured(limit = 50) {
  const r = await pool.query('SELECT * FROM get_featured_members($1)', [limit]);
  return r.rows;
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
  process.env.JWT_SECRET = 'test-secret-for-featured-members';
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

  const tokenFor = (id, role) => jwt.sign({ id, email: `fm${id}@test.com`, role }, process.env.JWT_SECRET);
  adminToken = tokenFor(await makeUser('admin'), 'admin');
  memberToken = tokenFor(await makeUser(), 'member');
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  // Windows can still hold a handle on the data directory when Postgres
  // exits, and embedded-postgres removes that directory as part of
  // stopping. The server is already down by then, so an EBUSY here is
  // the OS being slow to let go, not a failure worth failing the file
  // for — and a teardown that goes red teaches everyone to ignore red.
  try { if (pg) await pg.stop(); } catch (e) { /* see above */ }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* Windows holds the dir briefly */ }
});

// ---------------------------------------------------------------------------
// Every card has to open something
// ---------------------------------------------------------------------------

test('SOMEBODY WITH NO PROFILE IS NEVER FEATURED', async () => {
  // A card is a picture and a link. Someone with neither would render as a
  // grey box that goes nowhere, which reads as the site being broken.
  const nobody = await makeUser();
  await givePoints(nobody, 9999);   // the most active person on the site

  const rows = await featured();
  assert.ok(!rows.some((r) => r.display_name === null),
    'nothing nameless reached the row');
  const refs = rows.map((r) => r.ref);
  assert.ok(refs.every((ref) => ref && String(ref).trim()),
    'every card carries something to link to');
});

test('A DIRECTORY BUSINESS IS NOT FEATURED — this row is Unplug members', async () => {
  // 129 featured businesses too; the owner's instruction is that this row is
  // members. A business with a Directory listing but no My Unplug profile is
  // no longer eligible, however active it is.
  const uid = await makeUser();
  await giveBusiness(uid, 'Kagiso Motors');
  await givePoints(uid, 500);

  const rows = await featured();
  assert.ok(!rows.some((r) => r.display_name === 'Kagiso Motors'),
    'a Directory listing alone does not put somebody in the members row');
  assert.ok(rows.every((r) => r.kind === 'member'), 'every card is a member');
});

test('an individual is featured through their My Unplug profile', async () => {
  const uid = await makeUser();
  await giveMyUnplug(uid, 'Thandi M');
  await givePoints(uid, 400);

  const rows = await featured();
  const row = rows.find((r) => r.display_name === 'Thandi M');
  assert.ok(row, 'the member is eligible');
  assert.equal(row.kind, 'member');
  assert.ok(row.ref, 'and it has a username to link to');
});

test('somebody who is BOTH a member and a business gets exactly one card', async () => {
  const uid = await makeUser();
  await giveBusiness(uid, 'Double Trouble Trading');
  await giveMyUnplug(uid, 'Double Trouble Person');
  await givePoints(uid, 800);

  const rows = await featured();
  const mine = rows.filter((r) => /Double Trouble/.test(r.display_name || ''));
  assert.equal(mine.length, 1, 'one person, one card');
  assert.equal(mine[0].kind, 'member', 'and it is their member card, not the business');
});

// ---------------------------------------------------------------------------
// Who ranks where
// ---------------------------------------------------------------------------

test('THE MOST ACTIVE COME FIRST', async () => {
  const quiet = await makeUser();
  await giveMyUnplug(quiet, 'Quiet Trader');
  await givePoints(quiet, 1);

  const busy = await makeUser();
  await giveMyUnplug(busy, 'Busy Trader');
  await givePoints(busy, 100000);

  const rows = await featured();
  const busyAt = rows.findIndex((r) => r.display_name === 'Busy Trader');
  const quietAt = rows.findIndex((r) => r.display_name === 'Quiet Trader');
  assert.ok(busyAt > -1 && quietAt > -1);
  assert.ok(busyAt < quietAt, 'the more active of the two is higher up');
});

test('activity older than 30 days does not count', async () => {
  // The row is meant to show who is active NOW, not who once was.
  const old = await makeUser();
  await giveMyUnplug(old, 'Once Busy Trader');
  await givePoints(old, 50000, 90);   // three months ago

  const rows = await featured();
  const row = rows.find((r) => r.display_name === 'Once Busy Trader');
  assert.ok(row, 'they still appear — having a profile is what makes them eligible');
  assert.equal(Number(row.activity), 0, 'but their old activity scores nothing');
});

test('a reversed action cannot buy a place on the homepage', async () => {
  const cheat = await makeUser();
  await giveMyUnplug(cheat, 'Reversed Trader');
  const action = await pool.query('SELECT code FROM participation_actions LIMIT 1');
  if (action.rowCount === 0) return;
  await pool.query(
    `INSERT INTO participation_points (user_id, action_code, total_points, earned_at, is_reversed)
     VALUES ($1, $2, 99999, now(), TRUE)`, [cheat, action.rows[0].code]);

  const rows = await featured();
  const row = rows.find((r) => r.display_name === 'Reversed Trader');
  assert.equal(Number(row.activity), 0, 'a cancelled action counts for nothing');
});

test('AN ADMIN IS NEVER FEATURED', async () => {
  // Same reason they came off the leaderboard: running the site is not taking
  // part in it.
  const adminId = await makeUser('admin');
  await giveMyUnplug(adminId, 'The Admin Business');
  await givePoints(adminId, 999999);

  const rows = await featured();
  assert.ok(!rows.some((r) => r.display_name === 'The Admin Business'),
    'the owner does not feature on their own homepage');
});

test('the order is stable between page loads', async () => {
  // Ties are broken by name. Without that the row reshuffles at random on a
  // quiet site where everyone is on zero.
  const first = await featured(10);
  const second = await featured(10);
  assert.deepEqual(first.map((r) => r.display_name), second.map((r) => r.display_name));
});

// ---------------------------------------------------------------------------
// The admin-controlled count
// ---------------------------------------------------------------------------

test('IT SHOWS FIVE BY DEFAULT AND THE ADMIN CAN MAKE IT TEN', async () => {
  // Make sure there are more than ten eligible people to choose from.
  for (let i = 0; i < 12; i += 1) {
    const uid = await makeUser();
    await giveMyUnplug(uid, `Filler Member ${i}`);
    await givePoints(uid, 100 + i);
  }

  const seeded = await pool.query(`SELECT value FROM settings WHERE key = 'featured_members_count'`);
  assert.equal(seeded.rows[0].value, '5', 'five out of the box');

  const five = await req('GET', '/participation/featured-members');
  assert.equal(five.status, 200);
  assert.equal(five.body.members.length, 5);

  await pool.query(`UPDATE settings SET value = '10' WHERE key = 'featured_members_count'`);
  const ten = await req('GET', '/participation/featured-members');
  assert.equal(ten.body.members.length, 10, 'the admin can move it to ten with no deploy');
});

test('A NONSENSE COUNT CANNOT FLOOD THE HOMEPAGE', async () => {
  // This renders on the front page, so the setting is clamped rather than
  // trusted.
  await pool.query(`UPDATE settings SET value = '9999' WHERE key = 'featured_members_count'`);
  const huge = await req('GET', '/participation/featured-members');
  assert.ok(huge.body.limit <= 24, `limit was ${huge.body.limit}`);

  await pool.query(`UPDATE settings SET value = 'banana' WHERE key = 'featured_members_count'`);
  const bad = await req('GET', '/participation/featured-members');
  assert.equal(bad.status, 200, 'a bad value must not break the homepage');
  assert.equal(bad.body.limit, 5, 'it falls back to five');

  await pool.query(`UPDATE settings SET value = '0' WHERE key = 'featured_members_count'`);
  const zero = await req('GET', '/participation/featured-members');
  assert.ok(zero.body.limit >= 1);

  await pool.query(`UPDATE settings SET value = '5' WHERE key = 'featured_members_count'`);
});

test('re-running the migrations does not reset a count the admin changed', async () => {
  // migrate.js re-runs every .sql on every deploy; the seed is ON CONFLICT DO
  // NOTHING for the same reason the service prices are.
  await pool.query(`UPDATE settings SET value = '8' WHERE key = 'featured_members_count'`);
  // ALL of them, in order — which is exactly what a deploy does. Re-running
  // one file alone would not have caught that 129 and 130 both declare
  // get_featured_members with different shapes, and that running 129 second
  // fails outright.
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(dir, f), 'utf8'));
  }
  const after = await pool.query(`SELECT value FROM settings WHERE key = 'featured_members_count'`);
  assert.equal(after.rows[0].value, '8', 'a deploy must not undo the admin');
  await pool.query(`UPDATE settings SET value = '5' WHERE key = 'featured_members_count'`);
});

test('the endpoint is public — it renders on the homepage for signed-out readers', async () => {
  const anon = await req('GET', '/participation/featured-members');
  assert.equal(anon.status, 200);
  assert.ok(Array.isArray(anon.body.members));
});

// ---------------------------------------------------------------------------
// The admin's final say
// ---------------------------------------------------------------------------

test('A PINNED MEMBER APPEARS ABOVE MORE ACTIVE PEOPLE', async () => {
  const busy = await makeUser();
  await giveMyUnplug(busy, 'Very Busy Person');
  await givePoints(busy, 500000);

  const quiet = await makeUser();
  await giveMyUnplug(quiet, 'Quiet But Pinned');

  const pinned = await req('PUT', `/participation/admin/featured-members/${quiet}`, {
    token: adminToken, body: { state: 'pinned' },
  });
  assert.equal(pinned.status, 200);

  const rows = await featured(10);
  assert.equal(rows[0].display_name, 'Quiet But Pinned',
    'the admin decision beats the ranking');
  assert.equal(rows[0].is_pinned, true);
});

test('A REMOVED MEMBER NEVER APPEARS, HOWEVER ACTIVE', async () => {
  const uid = await makeUser();
  await giveMyUnplug(uid, 'Should Not Appear');
  await givePoints(uid, 999999);

  await req('PUT', `/participation/admin/featured-members/${uid}`, {
    token: adminToken, body: { state: 'removed' },
  });

  const rows = await featured(50);
  assert.ok(!rows.some((r) => r.display_name === 'Should Not Appear'),
    'the most active person on the site stays off the homepage');
});

test('REMOVING IS REVERSIBLE — restore hands them back to the ranking', async () => {
  const uid = await makeUser();
  await giveMyUnplug(uid, 'Removed Then Restored');
  await givePoints(uid, 250000);

  await req('PUT', `/participation/admin/featured-members/${uid}`, {
    token: adminToken, body: { state: 'removed' },
  });
  assert.ok(!(await featured(50)).some((r) => r.display_name === 'Removed Then Restored'));

  await req('PUT', `/participation/admin/featured-members/${uid}`, {
    token: adminToken, body: { state: 'auto' },
  });
  assert.ok((await featured(50)).some((r) => r.display_name === 'Removed Then Restored'),
    'a removal the admin cannot undo would be a trap');
});

test('the admin list shows removed people too, so a removal can be undone', async () => {
  const uid = await makeUser();
  await giveMyUnplug(uid, 'Hidden From Homepage');
  await req('PUT', `/participation/admin/featured-members/${uid}`, {
    token: adminToken, body: { state: 'removed' },
  });

  const list = await req('GET', '/participation/admin/featured-members', { token: adminToken });
  const row = list.body.members.find((m) => m.user_id === uid);
  assert.ok(row, 'a removal you cannot see is a removal you cannot reverse');
  assert.equal(row.state, 'removed');
});

test('somebody with no Unplug profile cannot be pinned', async () => {
  // An override on a member who can never be featured would sit in the table
  // doing nothing, and look to an admin like it had worked.
  const uid = await makeUser();
  const bad = await req('PUT', `/participation/admin/featured-members/${uid}`, {
    token: adminToken, body: { state: 'pinned' },
  });
  assert.equal(bad.status, 404);
  assert.match(bad.body.error, /no Unplug profile/i);
});

test('an unknown state is refused', async () => {
  const uid = await makeUser();
  await giveMyUnplug(uid, 'State Check');
  const bad = await req('PUT', `/participation/admin/featured-members/${uid}`, {
    token: adminToken, body: { state: 'featured-ish' },
  });
  assert.equal(bad.status, 400);
});

test('only an admin can pin or remove', async () => {
  const uid = await makeUser();
  await giveMyUnplug(uid, 'Auth Check');
  const asMember = await req('PUT', `/participation/admin/featured-members/${uid}`, {
    token: memberToken, body: { state: 'removed' },
  });
  assert.equal(asMember.status, 403);
  const asAnon = await req('PUT', `/participation/admin/featured-members/${uid}`, {
    body: { state: 'removed' },
  });
  assert.equal(asAnon.status, 401);
  const listAsMember = await req('GET', '/participation/admin/featured-members', { token: memberToken });
  assert.equal(listAsMember.status, 403);
});
