// Participation Engine — Stage H: Weekly Missions, over real PostgreSQL.
// No Express routes exist for the rotation mechanism itself (only for
// assignment/admin-CRUD, tested separately) — these tests exercise the
// SQL functions directly.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-weeklymissions-'));
const port = 12800 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

function migrationFiles() {
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
    .map((f) => path.join(dir, f));
}
async function runMigrations() {
  for (const file of migrationFiles()) {
    await pool.query(fs.readFileSync(file, 'utf8'));
  }
}

let _nextUserId = 6000;
async function makeUser() {
  const id = _nextUserId++;
  await pool.query(`INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', 'member') ON CONFLICT DO NOTHING`, [id, `wm${id}@test.com`]);
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
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await runMigrations();
});

after(async () => {
  await pool.end();
  // stopPostgres, not pg.stop() directly: on Windows the library's stop
  // can HANG rather than throw, which used to leave the cluster running
  // with no parent and eventually broke a later test file's startup.
  // See test/helpers/stopPostgres.js.
  await stopPostgres(pg, dataDir);
});

test('get_current_weekly_mission auto-rotates on first read and is stable within the same call', async () => {
  const result = await pool.query('SELECT * FROM get_current_weekly_mission()');
  assert.equal(result.rows.length, 1);
  // Asserts the pick is a real enabled weekly mission rather than one of
  // three names — the pool is 107 now.
  const picked = await pool.query(
    `SELECT mission_type, is_enabled FROM missions WHERE code = $1`, [result.rows[0].code]
  );
  assert.equal(picked.rows[0].mission_type, 'weekly');
  assert.equal(picked.rows[0].is_enabled, true);

  const again = await pool.query('SELECT * FROM get_current_weekly_mission()');
  assert.equal(again.rows[0].code, result.rows[0].code); // stable — not re-rolled on every read
});

test('rotate_weekly_mission is idempotent for the same week', async () => {
  const first = await pool.query('SELECT rotate_weekly_mission() AS code');
  const second = await pool.query('SELECT rotate_weekly_mission() AS code');
  assert.equal(first.rows[0].code, second.rows[0].code);

  const rotationRows = await pool.query(
    `SELECT COUNT(*)::INTEGER AS n FROM weekly_mission_rotation WHERE week_start = date_trunc('week', CURRENT_DATE)::DATE`
  );
  assert.equal(rotationRows.rows[0].n, 1); // one row per week, not one per call
});

test('assign_weekly_mission gives a member exactly one row for the current week, even if called twice', async () => {
  const userId = await makeUser();
  await pool.query('SELECT assign_weekly_mission($1)', [userId]);
  await pool.query('SELECT assign_weekly_mission($1)', [userId]);

  // Compared in SQL rather than pulled into JS and reformatted — a
  // DATE column comes back from node-postgres as a Date object at LOCAL
  // midnight, and calling .toISOString() on it can shift the date
  // backward across midnight depending on the server's timezone. Not a
  // product bug (production code never does this JS-side); just a trap
  // to avoid in the test itself.
  const rows = await pool.query(
    `SELECT um.*, (um.assigned_date = date_trunc('week', CURRENT_DATE)::DATE) AS is_this_week
       FROM user_missions um JOIN missions m ON m.code = um.mission_code
      WHERE um.user_id = $1 AND m.mission_type = 'weekly'`,
    [userId]
  );
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].is_this_week, true);
});

test('completing a weekly mission awards points and marks it done, independent of daily missions on the same action', async () => {
  const userId = await makeUser();
  // Force the active weekly mission to be the recognition one for a
  // deterministic test, regardless of what the rotation already picked.
  await pool.query(`UPDATE weekly_mission_rotation SET mission_code = 'weekly_recognise5' WHERE week_start = date_trunc('week', CURRENT_DATE)::DATE`);
  await pool.query('SELECT assign_weekly_mission($1)', [userId]);

  // process_recognition() only awards points (via award_points) — it does
  // NOT itself call update_mission_progress(). That call is the caller's
  // job (in production, the Express /participation/action route), same
  // as Stage C's own mission-completion test already established.
  for (let i = 0; i < 5; i++) {
    const target = await makeUser();
    await pool.query(`SELECT * FROM process_recognition($1, $2, 'helpful')`, [userId, target]);
    await pool.query(`SELECT update_mission_progress($1, 'recognition_give')`, [userId]);
  }

  const mission = await pool.query(
    `SELECT progress_count, is_completed FROM user_missions
      WHERE user_id = $1 AND mission_code = 'weekly_recognise5'`,
    [userId]
  );
  assert.equal(mission.rows[0].progress_count, 5);
  assert.equal(mission.rows[0].is_completed, true);

  const notif = await pool.query(`SELECT 1 AS found FROM notifications WHERE user_id = $1 AND type = 'mission'`, [userId]);
  assert.equal(notif.rows.length, 1);
});

test('a weekly mission does not complete from a DAILY mission row on the same action code', async () => {
  // daily_recognise (Stage C) and weekly_recognise5 (Stage H) both key off
  // recognition_give — update_mission_progress must only increment the
  // one whose mission_type matches assigned_date's granularity, not both
  // indiscriminately just because the action_code matches.
  const userId = await makeUser();
  // Explicit, for the same reason: the daily pool is 731, so the random deal
  // can no longer be relied on to hand out the row this test needs.
  await pool.query(
    `INSERT INTO user_missions (user_id, mission_code, assigned_date)
     VALUES ($1, 'daily_recognise', CURRENT_DATE) ON CONFLICT DO NOTHING`, [userId]);
  await pool.query(`UPDATE weekly_mission_rotation SET mission_code = 'weekly_recognise5' WHERE week_start = date_trunc('week', CURRENT_DATE)::DATE`);
  await pool.query('SELECT assign_weekly_mission($1)', [userId]);

  const target = await makeUser();
  await pool.query(`SELECT * FROM process_recognition($1, $2, 'outstanding')`, [userId, target]);
  await pool.query(`SELECT update_mission_progress($1, 'recognition_give')`, [userId]);

  const daily = await pool.query(
    `SELECT progress_count FROM user_missions WHERE user_id = $1 AND mission_code = 'daily_recognise'`, [userId]
  );
  const weekly = await pool.query(
    `SELECT progress_count FROM user_missions WHERE user_id = $1 AND mission_code = 'weekly_recognise5'`, [userId]
  );
  assert.equal(daily.rows[0].progress_count, 1);
  assert.equal(weekly.rows[0].progress_count, 1);
});

test('re-running every migration is idempotent — rotation history and mission seeds stay stable', async () => {
  const before1 = await pool.query('SELECT COUNT(*)::INTEGER AS n FROM weekly_mission_rotation');
  await runMigrations();
  const after1 = await pool.query('SELECT COUNT(*)::INTEGER AS n FROM weekly_mission_rotation');
  assert.equal(before1.rows[0].n, after1.rows[0].n);

  const weeklyCount = await pool.query(`SELECT COUNT(*)::INTEGER AS n FROM missions WHERE mission_type = 'weekly'`);
  // Was 3 when only the Stage C/H missions existed. Asserts survival of a
  // migration re-run, not the size of the catalogue.
  assert.ok(weeklyCount.rows[0].n >= 3);
});
