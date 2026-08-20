// THE 2000-BADGE CATALOGUE — seeding, editing, and awarding many members at
// once.
//
// The guarantees worth testing hardest:
//   1. The seed must NEVER overwrite an admin's edit. Migrations re-run on
//      every deploy here, so an upsert would silently reset every relabelled,
//      recategorised or disabled badge back to the spreadsheet — and it would
//      happen again on the next deploy, and the next.
//   2. All 2000 rows land, with their emoji and category intact.
//   3. A bulk award must apply to everyone selected, tell the truth about who
//      already had it, and not be discarded wholesale because one id was bad.
//   4. The list has to stay usable at 2000 — searchable, filterable, paged.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-badgecat-'));
const port = 26000 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');
function migrationFiles() {
  return fs.readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort();
}
async function runMigrations() {
  for (const f of migrationFiles()) {
    await pool.query(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
  }
}

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

let jwt;
function tokenFor(userId, role = 'member') {
  return jwt.sign({ id: userId, email: `bc${userId}@test.com`, role }, process.env.JWT_SECRET);
}

let _nextUserId = 151000;
async function makeUser(role = 'member') {
  const id = _nextUserId++;
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role, full_name)
     VALUES ($1, $2, 'x', $3, $4) ON CONFLICT DO NOTHING`,
    [id, `bc${id}@test.com`, role, `Member ${id}`]
  );
  return id;
}

let adminToken;
let memberToken;

before(async () => {
  pg = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'postgres', password: 'postgres', port,
    persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('unplug_test');

  process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${port}/unplug_test`;
  process.env.JWT_SECRET = 'test-secret-for-badge-catalogue';
  process.env.UNPLUG_DISABLE_RATE_LIMITS = '1';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await runMigrations();

  jwt = require('jsonwebtoken');

  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/badges', require('../src/routes/badges'));
  app.use('/members', require('../src/routes/members'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  adminToken = tokenFor(await makeUser('admin'), 'admin');
  memberToken = tokenFor(await makeUser('member'), 'member');
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

// --- The catalogue itself ---------------------------------------------------

test('all 2000 badges are seeded, with emoji and category intact', async () => {
  const n = await pool.query('SELECT COUNT(*)::int AS n FROM badges');
  assert.ok(n.rows[0].n >= 2000, `expected at least 2000 badges, got ${n.rows[0].n}`);

  const sample = await pool.query(
    `SELECT label, emoji, category FROM badges WHERE code = 'motivation_rising_star'`
  );
  assert.equal(sample.rows[0].label, 'Motivation & Inspiration Rising Star');
  assert.equal(sample.rows[0].category, 'Motivation & Inspiration');
  assert.ok(sample.rows[0].emoji.length > 0, 'the emoji should have survived the seed');

  // Nothing truncated or blank anywhere.
  const bad = await pool.query(
    `SELECT COUNT(*)::int AS n FROM badges
      WHERE code = '' OR label = '' OR description = '' OR emoji = '' OR category = ''`
  );
  assert.equal(bad.rows[0].n, 0);
});

test('the catalogue spans many categories', async () => {
  const res = await req('GET', '/badges/admin/categories', { token: adminToken });
  assert.equal(res.status, 200);
  assert.ok(res.body.categories.length >= 150, `expected 150+ categories, got ${res.body.categories.length}`);
  const total = res.body.categories.reduce((sum, c) => sum + c.badges, 0);
  assert.ok(total >= 2000);
});

test('RE-SEEDING NEVER OVERWRITES AN ADMIN EDIT', async () => {
  // The single most important test in this file. Migrations re-run on every
  // deploy, so if the seed upserted, every edit an admin ever made would be
  // silently reverted — repeatedly, and with no error to notice.
  await req('PATCH', '/badges/admin/motivation_standout', {
    token: adminToken,
    body: { label: 'Renamed By The Admin', category: 'Custom', isEnabled: false },
  });

  await runMigrations();

  const after = await pool.query(
    `SELECT label, category, is_enabled FROM badges WHERE code = 'motivation_standout'`
  );
  assert.equal(after.rows[0].label, 'Renamed By The Admin', 'the admin edit must survive a re-deploy');
  assert.equal(after.rows[0].category, 'Custom');
  assert.equal(after.rows[0].is_enabled, false, 'a disabled badge must stay disabled');
});

test('re-seeding does not duplicate anything', async () => {
  const before = await pool.query('SELECT COUNT(*)::int AS n FROM badges');
  await runMigrations();
  const after = await pool.query('SELECT COUNT(*)::int AS n FROM badges');
  assert.equal(after.rows[0].n, before.rows[0].n);
});

// --- The list has to stay usable at 2000 ------------------------------------

test('the admin list is paged rather than returning 2000 rows', async () => {
  const res = await req('GET', '/badges/admin/all', { token: adminToken });
  assert.equal(res.status, 200);
  assert.ok(res.body.badges.length <= 500, 'a default request must not return the whole catalogue');
  assert.ok(res.body.total >= 2000, 'but it must say how many there really are');
  assert.equal(res.body.hasMore, true);
});

test('the admin list can be searched and filtered', async () => {
  const search = await req('GET', '/badges/admin/all?q=Rising%20Star', { token: adminToken });
  assert.ok(search.body.badges.length > 0);
  assert.ok(search.body.badges.every((b) =>
    /rising star/i.test(b.label) || /rising star/i.test(b.description) || /rising star/i.test(b.code)));

  const byCategory = await req('GET', '/badges/admin/all?category=Photography', { token: adminToken });
  assert.ok(byCategory.body.badges.length > 0);
  assert.ok(byCategory.body.badges.every((b) => b.category === 'Photography'));
});

test('an absurd page size is capped, not honoured', async () => {
  const res = await req('GET', '/badges/admin/all?limit=99999', { token: adminToken });
  assert.ok(res.body.badges.length <= 500);
  assert.equal(res.body.limit, 500);
});

// --- Awarding many members at once ------------------------------------------

test('one badge can be awarded to many members in a single action', async () => {
  const ids = [await makeUser(), await makeUser(), await makeUser()];
  const res = await req('POST', '/badges/admin/recog_022/award-bulk', {
    token: adminToken, body: { userIds: ids, reason: 'Finalists' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.awarded, 3);
  assert.equal(res.body.alreadyHad, 0);

  const held = await pool.query(
    `SELECT COUNT(*)::int AS n FROM user_badges WHERE badge_code = 'recog_022' AND user_id = ANY($1)`, [ids]
  );
  assert.equal(held.rows[0].n, 3, 'every selected member should actually hold it');
});

test('awarding the same members again reports them, and does not duplicate', async () => {
  const ids = [await makeUser(), await makeUser()];
  await req('POST', '/badges/admin/recog_023/award-bulk', { token: adminToken, body: { userIds: ids } });
  const second = await req('POST', '/badges/admin/recog_023/award-bulk', { token: adminToken, body: { userIds: ids } });
  assert.equal(second.body.awarded, 0);
  assert.equal(second.body.alreadyHad, 2);

  const held = await pool.query(
    `SELECT COUNT(*)::int AS n FROM user_badges WHERE badge_code = 'recog_023' AND user_id = ANY($1)`, [ids]
  );
  assert.equal(held.rows[0].n, 2, 'no duplicate rows');
});

test('one bad id does not discard the rest of the batch', async () => {
  // The reason this is not a single transaction: forty-nine good awards must
  // not be thrown away because the fiftieth id was mistyped.
  const good = [await makeUser(), await makeUser()];
  const res = await req('POST', '/badges/admin/creator_001/award-bulk', {
    token: adminToken, body: { userIds: [...good, 99999999] },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.awarded, 2, 'the valid members are still awarded');
  assert.deepEqual(res.body.notFound, [99999999], 'and the bad one is named');
});

test('the same member listed twice counts once', async () => {
  const id = await makeUser();
  const res = await req('POST', '/badges/admin/creator_002/award-bulk', {
    token: adminToken, body: { userIds: [id, id, id] },
  });
  assert.equal(res.body.awarded, 1);
  assert.equal(res.body.alreadyHad, 0, 'a duplicate in the request is not "already had it"');
});

test('a bulk award respects the month/year period', async () => {
  const ids = [await makeUser(), await makeUser()];
  await req('POST', '/badges/admin/creator_003/award-bulk', {
    token: adminToken, body: { userIds: ids, awardMonth: 8, awardYear: 2026 },
  });
  // The same badge for a DIFFERENT month is a genuine second award.
  const second = await req('POST', '/badges/admin/creator_003/award-bulk', {
    token: adminToken, body: { userIds: ids, awardMonth: 9, awardYear: 2026 },
  });
  assert.equal(second.body.awarded, 2);

  const held = await pool.query(
    `SELECT COUNT(*)::int AS n FROM user_badges WHERE badge_code = 'creator_003' AND user_id = ANY($1)`, [ids]
  );
  assert.equal(held.rows[0].n, 4, 'two members, two periods each');
});

test('an empty or oversized selection is refused', async () => {
  assert.equal((await req('POST', '/badges/admin/recog_022/award-bulk', {
    token: adminToken, body: { userIds: [] },
  })).status, 400);

  assert.equal((await req('POST', '/badges/admin/recog_022/award-bulk', {
    token: adminToken, body: { userIds: Array.from({ length: 501 }, (_, i) => i + 1) },
  })).status, 400);
});

test('a bulk award on an unknown badge is a 404, not a silent no-op', async () => {
  const res = await req('POST', '/badges/admin/not_a_real_badge/award-bulk', {
    token: adminToken, body: { userIds: [await makeUser()] },
  });
  assert.equal(res.status, 404);
});

test('badge admin endpoints are admin-only', async () => {
  assert.equal((await req('GET', '/badges/admin/all')).status, 401);
  assert.equal((await req('GET', '/badges/admin/all', { token: memberToken })).status, 403);
  assert.equal((await req('GET', '/badges/admin/categories', { token: memberToken })).status, 403);
  assert.equal((await req('POST', '/badges/admin/recog_022/award-bulk', {
    token: memberToken, body: { userIds: [1] },
  })).status, 403);
});

// --- The Members page "Badges" filter --------------------------------------

test('the Badges filter shows ONLY members who hold a badge', async () => {
  // A filter, not just an ordering: a member with no badges must never appear
  // under it, however high they rank on anything else.
  const withBadge = await makeUser();
  const without = await makeUser();
  for (const [uid, slug, name] of [[withBadge, 'badged-member', 'Badged Member'], [without, 'plain-member', 'Plain Member']]) {
    await pool.query(
      `INSERT INTO profiles (user_id, type, package_tier, slug, display_name, status)
       VALUES ($1, 'individual', 'basic', $2, $3, 'approved')`,
      [uid, slug, name]
    );
  }
  await req('POST', '/badges/admin/aviation_03/award-bulk', {
    token: adminToken, body: { userIds: [withBadge] },
  });

  const res = await req('GET', '/members?sort=badged&limit=60');
  assert.equal(res.status, 200);
  const names = res.body.members.map((m) => m.display_name);
  assert.ok(names.includes('Badged Member'));
  assert.ok(!names.includes('Plain Member'), 'a member with no badge must not appear');
});

test('every card carries a badge_count, and the badged view is most-decorated first', async () => {
  const many = await makeUser();
  await pool.query(
    `INSERT INTO profiles (user_id, type, package_tier, slug, display_name, status)
     VALUES ($1, 'individual', 'basic', 'most-decorated', 'Most Decorated', 'approved')`,
    [many]
  );
  for (const code of ['aviation_03', 'creator_001', 'creator_002', 'recog_022']) {
    await req('POST', `/badges/admin/${code}/award-bulk`, { token: adminToken, body: { userIds: [many] } });
  }

  const res = await req('GET', '/members?sort=badged&limit=60');
  assert.equal(res.body.members[0].display_name, 'Most Decorated', 'most badges should lead');
  assert.equal(Number(res.body.members[0].badge_count), 4);
  // And the count travels on every tab, not only this one.
  const newest = await req('GET', '/members?sort=newest&limit=60');
  assert.ok(newest.body.members.every((m) => m.badge_count !== undefined));
});

test('an unknown sort falls back to newest rather than erroring', async () => {
  const res = await req('GET', '/members?sort=not_a_sort');
  assert.equal(res.status, 200);
  assert.equal(res.body.sort, 'newest');
});
