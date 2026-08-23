// TOP 10 PLACEMENT BADGES — Champion, Runner-Up, Third Place.
//
// Awarded automatically when the Top 10 is published at the end of each
// month. The guarantees worth testing hardest:
//   1. Only the top THREE get one. Fourth place must earn nothing.
//   2. The badge is stamped with the month published, so winning in two
//      different months gives a member two badges rather than one.
//   3. REPUBLISHING A CORRECTED MONTH MOVES THE BADGE. If the rankings are
//      fixed, the previous winner must not keep "Champion — August" while
//      the real winner also holds it. Two champions for one month is the
//      failure that would be visible on the public profiles of both.
//   4. A listing with no owner account cannot be awarded one, and must not
//      break the publish.
//   5. The rankings are published either way — a badge problem must never
//      make a successful publish look like a failure.
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
const { stopPostgres } = require('./helpers/stopPostgres');

let pg;
let pool;
let server;
let baseUrl;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-t10badge-'));
const port = 26800 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

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
  return jwt.sign({ id: userId, email: `tb${userId}@test.com`, role }, process.env.JWT_SECRET);
}

let _nextUserId = 171000;
let _nextSlug = 0;

async function makeUser() {
  const id = _nextUserId++;
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', 'member')
     ON CONFLICT DO NOTHING`,
    [id, `tb${id}@test.com`]
  );
  return id;
}

// profiles.user_id is NOT NULL, so every listing always has an owner account
// — an ownerless listing is not a state this database can hold.
async function makeProfile() {
  const userId = await makeUser();
  const r = await pool.query(
    `INSERT INTO profiles (user_id, type, package_tier, slug, display_name, status)
     VALUES ($1, 'individual', 'basic', $2, $3, 'approved') RETURNING id`,
    [userId, `t10-badge-${_nextSlug++}`, `Contestant ${_nextSlug}`]
  );
  return { userId, profileId: r.rows[0].id };
}

async function badgesHeldBy(userId) {
  const r = await pool.query(
    `SELECT badge_code, award_month, award_year FROM user_badges
      WHERE user_id = $1 ORDER BY badge_code`, [userId]
  );
  return r.rows;
}

let adminToken;

before(async () => {
  pg = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'postgres', password: 'postgres', port,
    persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('unplug_test');

  process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${port}/unplug_test`;
  process.env.JWT_SECRET = 'test-secret-for-top10-badges';
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
  app.use('/', require('../src/routes/competitions'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const adminId = await makeUser();
  await pool.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [adminId]);
  adminToken = tokenFor(adminId, 'admin');
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  // stopPostgres, not pg.stop() directly: on Windows the library's stop
  // can HANG rather than throw, which used to leave the cluster running
  // with no parent and eventually broke a later test file's startup.
  // See test/helpers/stopPostgres.js.
  await stopPostgres(pg, dataDir);
});

test('the three placement badges exist', async () => {
  const r = await pool.query(
    `SELECT code, label, emoji FROM badges
      WHERE code IN ('top10_champion','top10_runner_up','top10_third_place') ORDER BY sort_order`
  );
  assert.equal(r.rows.length, 3);
  assert.deepEqual(r.rows.map((b) => b.label),
    ['Top 10 Champion', 'Top 10 Runner-Up', 'Top 10 Third Place']);
  r.rows.forEach((b) => assert.ok(b.emoji.length > 0));
});

test('the badge definitions carry NO fixed period', async () => {
  // They recur every month. A period on the definition would pin every future
  // winner to whichever month happened to be set here.
  const r = await pool.query(
    `SELECT award_month, award_year FROM badges WHERE code = 'top10_champion'`
  );
  assert.equal(r.rows[0].award_month, null);
  assert.equal(r.rows[0].award_year, null);
});

test('publishing awards the top three, stamped with the month', async () => {
  const first = await makeProfile();
  const second = await makeProfile();
  const third = await makeProfile();
  const fourth = await makeProfile();

  const res = await req('POST', '/top10/publish', {
    token: adminToken,
    body: {
      awardMonth: 8, awardYear: 2026,
      rankings: [
        { profileId: first.profileId, rank: 1 },
        { profileId: second.profileId, rank: 2 },
        { profileId: third.profileId, rank: 3 },
        { profileId: fourth.profileId, rank: 4 },
      ],
    },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.awardedBadges.length, 3);

  assert.deepEqual(await badgesHeldBy(first.userId),
    [{ badge_code: 'top10_champion', award_month: 8, award_year: 2026 }]);
  assert.deepEqual(await badgesHeldBy(second.userId),
    [{ badge_code: 'top10_runner_up', award_month: 8, award_year: 2026 }]);
  assert.deepEqual(await badgesHeldBy(third.userId),
    [{ badge_code: 'top10_third_place', award_month: 8, award_year: 2026 }]);

  // Fourth place earns nothing at all.
  assert.deepEqual(await badgesHeldBy(fourth.userId), []);
});

test('REPUBLISHING A CORRECTED MONTH MOVES THE BADGE', async () => {
  // The failure this prevents: two people both holding "Champion — September",
  // visible on both their public profiles, with no way to tell which is real.
  const wrongWinner = await makeProfile();
  const realWinner = await makeProfile();

  await req('POST', '/top10/publish', {
    token: adminToken,
    body: { awardMonth: 9, awardYear: 2026, rankings: [{ profileId: wrongWinner.profileId, rank: 1 }] },
  });
  assert.equal((await badgesHeldBy(wrongWinner.userId)).length, 1);

  // The result is corrected and republished for the SAME month.
  await req('POST', '/top10/publish', {
    token: adminToken,
    body: { awardMonth: 9, awardYear: 2026, rankings: [{ profileId: realWinner.profileId, rank: 1 }] },
  });

  assert.deepEqual(await badgesHeldBy(wrongWinner.userId), [],
    'the previous winner must lose the badge when the month is corrected');
  assert.deepEqual(await badgesHeldBy(realWinner.userId),
    [{ badge_code: 'top10_champion', award_month: 9, award_year: 2026 }]);
});

test('winning in two different months gives two separate badges', async () => {
  const repeatWinner = await makeProfile();

  await req('POST', '/top10/publish', {
    token: adminToken,
    body: { awardMonth: 10, awardYear: 2026, rankings: [{ profileId: repeatWinner.profileId, rank: 1 }] },
  });
  await req('POST', '/top10/publish', {
    token: adminToken,
    body: { awardMonth: 11, awardYear: 2026, rankings: [{ profileId: repeatWinner.profileId, rank: 1 }] },
  });

  const held = await badgesHeldBy(repeatWinner.userId);
  assert.equal(held.length, 2, 'a second month is a second badge, not a silent overwrite');
  assert.deepEqual(held.map((b) => b.award_month).sort((a, b) => a - b), [10, 11]);
});

test('publishing the same month twice unchanged does not duplicate', async () => {
  const winner = await makeProfile();
  const body = { awardMonth: 12, awardYear: 2026, rankings: [{ profileId: winner.profileId, rank: 1 }] };

  await req('POST', '/top10/publish', { token: adminToken, body });
  await req('POST', '/top10/publish', { token: adminToken, body });

  assert.equal((await badgesHeldBy(winner.userId)).length, 1);
});

test('a publish that fails awards NOBODY a badge', async () => {
  // top10_rankings.profile_id is a foreign key, so a rank naming a listing
  // that no longer exists is refused outright and the whole publish rolls
  // back. What matters here is that badges follow the same fate: a Top 10
  // that never went live must not leave someone holding a Champion badge for
  // a month with no published rankings behind it.
  const gone = await makeProfile();
  await pool.query('DELETE FROM profiles WHERE id = $1', [gone.profileId]);
  const alsoRan = await makeProfile();

  const res = await req('POST', '/top10/publish', {
    token: adminToken,
    body: {
      awardMonth: 1, awardYear: 2027,
      rankings: [
        { profileId: alsoRan.profileId, rank: 1 },
        { profileId: gone.profileId, rank: 2 },
      ],
    },
  });
  assert.notEqual(res.status, 200, 'a ranking for a deleted listing must not publish');

  assert.deepEqual(await badgesHeldBy(alsoRan.userId), [],
    'no badge may survive a publish that rolled back');
});

test('the rankings themselves are published regardless', async () => {
  const winner = await makeProfile();
  await req('POST', '/top10/publish', {
    token: adminToken,
    body: { awardMonth: 2, awardYear: 2027, periodLabel: 'February 2027',
            rankings: [{ profileId: winner.profileId, rank: 1 }] },
  });
  const live = await pool.query('SELECT profile_id, rank, period_label FROM top10_rankings ORDER BY rank');
  assert.equal(live.rows[0].profile_id, winner.profileId);
  assert.equal(live.rows[0].period_label, 'February 2027');
});

test('publishing is admin-only', async () => {
  const memberToken = tokenFor(await makeUser(), 'member');
  const body = { rankings: [{ profileId: 1, rank: 1 }] };
  assert.equal((await req('POST', '/top10/publish', { body })).status, 401);
  assert.equal((await req('POST', '/top10/publish', { token: memberToken, body })).status, 403);
});

test('re-running every migration is idempotent', async () => {
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM badges
      WHERE code IN ('top10_champion','top10_runner_up','top10_third_place')`
  );
  assert.equal(r.rows[0].n, 3, 'no duplicates after a re-run');
});
