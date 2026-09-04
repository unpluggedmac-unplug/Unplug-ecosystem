// Let a member click a daily/weekly/monthly mission open, and mark it
// complete themselves — POST /participation/missions/:code/complete.
//
// Requested directly, then narrowed by two clarifying questions before any
// code was written: completion is a trust-based SELF-REPORT (no proof
// required, same as ticking off a paper to-do list), and it applies the
// same way to all three mission types. This does not replace the existing
// automatic path (a mission still completes itself the instant the real
// tracked action happens elsewhere on the site) — it adds a second way to
// finish the same row, through complete_mission_manually() in
// 174_mission_manual_complete.sql, reusing the exact award_points() +
// notification + achievement-sync sequence the automatic path already uses.
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
const jwt = require('jsonwebtoken');
const EmbeddedPostgres = require('embedded-postgres').default;
const { stopPostgres } = require('./helpers/stopPostgres');

let pg;
let pool;
let server;
let API_BASE;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-mission-complete-'));
const port = 57000 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');
async function runMigrations() {
  for (const f of fs.readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
  }
}

let _nextUserId = 171000;
async function makeUser() {
  const id = _nextUserId++;
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', 'member')
     ON CONFLICT DO NOTHING`,
    [id, `msc${id}@test.com`]
  );
  return id;
}

function tokenFor(userId) {
  return jwt.sign({ id: userId, role: 'member' }, process.env.JWT_SECRET);
}

async function api(path, userId, options = {}) {
  const res = await fetch(API_BASE + path, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(userId ? { Authorization: 'Bearer ' + tokenFor(userId) } : {}),
    },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
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
  process.env.JWT_SECRET = 'test-secret-for-mission-complete';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await runMigrations();

  // Only src/routes/participation.js is mounted (the same pattern every
  // other route test in this codebase uses — src/app.js can't be required
  // directly in tests, it calls .listen() and starts the participation
  // scheduler's setInterval timers unconditionally at module load).
  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/participation', require('../src/routes/participation'));
  app.use((req, res) => res.status(404).json({ error: 'not found' }));
  app.use((err, req, res, next) => { res.status(500).json({ error: err.message }); });

  server = app.listen(0);
  API_BASE = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  // stopPostgres, not pg.stop() directly: on Windows the library's stop can
  // HANG rather than throw. See test/helpers/stopPostgres.js.
  await stopPostgres(pg, dataDir);
});

// A fixed, real daily mission (D001) assigned directly, bypassing the
// random assign_daily_missions() picker, so every test targets one exact
// row instead of whatever happened to be dealt today.
async function assignDaily(userId, missionCode) {
  await pool.query(
    `INSERT INTO user_missions (user_id, mission_code, assigned_date, progress_count, is_completed)
     VALUES ($1, $2, CURRENT_DATE, 0, FALSE) ON CONFLICT DO NOTHING`,
    [userId, missionCode]
  );
}

test('CLICKING "MARK AS COMPLETE" AWARDS THE MISSION\'S OWN POINTS, NO REAL ACTION NEEDED', async () => {
  const userId = await makeUser();
  await assignDaily(userId, 'D001'); // 5 points, target 1, action_code save_content

  const r = await api('/participation/missions/D001/complete', userId, { method: 'POST' });
  assert.equal(r.status, 200);
  assert.equal(r.body.success, true);
  assert.equal(r.body.pointsAwarded, 5);

  const row = await pool.query('SELECT is_completed, progress_count, points_tx_id FROM user_missions WHERE user_id = $1 AND mission_code = $2', [userId, 'D001']);
  assert.equal(row.rows[0].is_completed, true);
  assert.equal(row.rows[0].progress_count, 1);
  assert.ok(row.rows[0].points_tx_id, 'a real points ledger row must back the completion');

  // The award must be a REAL ledger entry, not just a flag flipped on
  // user_missions — same table/columns award_points() itself writes to.
  const ledger = await pool.query(
    'SELECT total_points, action_code, is_reversed FROM participation_points WHERE id = $1',
    [row.rows[0].points_tx_id]
  );
  assert.equal(ledger.rows[0].total_points, 5);
  assert.equal(ledger.rows[0].action_code, 'mission_complete');
  assert.equal(ledger.rows[0].is_reversed, false);
});

test('A MISSION NOT ASSIGNED TO THIS MEMBER CANNOT BE COMPLETED', async () => {
  const userId = await makeUser();
  // D002 exists in the catalogue but was never assigned to this member today.
  const r = await api('/participation/missions/D002/complete', userId, { method: 'POST' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /not currently assigned/i);
});

test('THE SAME MISSION CANNOT BE COMPLETED TWICE', async () => {
  const userId = await makeUser();
  await assignDaily(userId, 'D003');
  const first = await api('/participation/missions/D003/complete', userId, { method: 'POST' });
  assert.equal(first.status, 200);

  const second = await api('/participation/missions/D003/complete', userId, { method: 'POST' });
  assert.equal(second.status, 400);
  assert.match(second.body.error, /already completed/i);

  const ledgerCheck = await pool.query(
    `SELECT COUNT(*)::int AS n FROM participation_points WHERE user_id = $1 AND notes LIKE '%D003%'`,
    [userId]
  );
  assert.equal(ledgerCheck.rows[0].n, 1, 'exactly one ledger entry — the second click must not pay out again');
});

test('AN UNKNOWN MISSION CODE IS REJECTED, NOT SILENTLY IGNORED', async () => {
  const userId = await makeUser();
  const r = await api('/participation/missions/NOPE999/complete', userId, { method: 'POST' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /unknown mission/i);
});

test('SELF-COMPLETING ONE MEMBER\'S MISSION NEVER TOUCHES ANOTHER MEMBER\'S ROW', async () => {
  const userA = await makeUser();
  const userB = await makeUser();
  await assignDaily(userA, 'D004');
  await assignDaily(userB, 'D004');

  await api('/participation/missions/D004/complete', userA, { method: 'POST' });

  const rowA = await pool.query('SELECT is_completed FROM user_missions WHERE user_id = $1 AND mission_code = $2', [userA, 'D004']);
  const rowB = await pool.query('SELECT is_completed FROM user_missions WHERE user_id = $1 AND mission_code = $2', [userB, 'D004']);
  assert.equal(rowA.rows[0].is_completed, true);
  assert.equal(rowB.rows[0].is_completed, false);
});

test('SIGNING OUT REFUSES THE REQUEST — THIS IS A MEMBER-ONLY ACTION', async () => {
  const r = await api('/participation/missions/D001/complete', null, { method: 'POST' });
  assert.equal(r.status, 401);
});

test('A WEEKLY MISSION SELF-COMPLETES THE SAME WAY, FOR THE FULL POINTS_REWARD REGARDLESS OF TARGET_COUNT', async () => {
  const userId = await makeUser();
  const weekStart = (await pool.query(`SELECT date_trunc('week', CURRENT_DATE)::DATE AS d`)).rows[0].d;
  const mission = await pool.query(`SELECT code, points_reward, target_count FROM missions WHERE mission_type = 'weekly' LIMIT 1`);
  const { code, points_reward: pointsReward, target_count: targetCount } = mission.rows[0];
  assert.ok(targetCount >= 1);

  await pool.query(
    `INSERT INTO user_missions (user_id, mission_code, assigned_date, progress_count, is_completed)
     VALUES ($1, $2, $3, 0, FALSE) ON CONFLICT DO NOTHING`,
    [userId, code, weekStart]
  );

  const r = await api(`/participation/missions/${code}/complete`, userId, { method: 'POST' });
  assert.equal(r.status, 200);
  assert.equal(r.body.pointsAwarded, pointsReward);

  const row = await pool.query('SELECT is_completed, progress_count FROM user_missions WHERE user_id = $1 AND mission_code = $2', [userId, code]);
  assert.equal(row.rows[0].is_completed, true);
  assert.equal(row.rows[0].progress_count, targetCount, 'manual completion jumps straight to the target, not +1');
});

test('A MONTHLY CHALLENGE SELF-COMPLETES THE SAME WAY', async () => {
  const userId = await makeUser();
  const monthStart = (await pool.query(`SELECT date_trunc('month', CURRENT_DATE)::DATE AS d`)).rows[0].d;
  const mission = await pool.query(`SELECT code, points_reward FROM missions WHERE mission_type = 'challenge' LIMIT 1`);
  const { code, points_reward: pointsReward } = mission.rows[0];

  await pool.query(
    `INSERT INTO user_missions (user_id, mission_code, assigned_date, progress_count, is_completed)
     VALUES ($1, $2, $3, 0, FALSE) ON CONFLICT DO NOTHING`,
    [userId, code, monthStart]
  );

  const r = await api(`/participation/missions/${code}/complete`, userId, { method: 'POST' });
  assert.equal(r.status, 200);
  assert.equal(r.body.pointsAwarded, pointsReward);
});

test('THE DASHBOARD PAYLOAD STILL CARRIES mission_code FOR EVERY MISSION SHAPE, WHICH THE MEMBER-DASHBOARD MODAL DEPENDS ON', async () => {
  const userId = await makeUser();
  await pool.query('SELECT assign_daily_missions($1)', [userId]);
  const r = await api('/participation/dashboard', userId);
  assert.equal(r.status, 200);
  for (const m of r.body.todayMissions) {
    assert.ok(m.mission_code, 'every daily mission row needs mission_code so the dashboard can look it up when clicked');
  }
});
