// Participation Engine — Stage L: Monthly Challenges, over real
// PostgreSQL. Same shape as weeklyMissions.test.js — the rotation
// mechanism is identical, just at month granularity.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-monthlychallenges-'));
const port = 14000 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

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

let _nextUserId = 9000;
async function makeUser() {
  const id = _nextUserId++;
  await pool.query(`INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', 'member') ON CONFLICT DO NOTHING`, [id, `mc${id}@test.com`]);
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

test('get_current_monthly_challenge auto-rotates on first read and is stable within the same call', async () => {
  const result = await pool.query('SELECT * FROM get_current_monthly_challenge()');
  assert.equal(result.rows.length, 1);
  // Asserts WHAT was picked is valid, not WHICH one. The pool was two
  // seeded challenges; it is now 38, and naming them would break again on
  // the next content drop.
  const picked = await pool.query(
    `SELECT mission_type, is_enabled FROM missions WHERE code = $1`, [result.rows[0].code]
  );
  assert.ok(['monthly', 'challenge'].includes(picked.rows[0].mission_type));
  assert.equal(picked.rows[0].is_enabled, true);

  const again = await pool.query('SELECT * FROM get_current_monthly_challenge()');
  assert.equal(again.rows[0].code, result.rows[0].code);
});

test('rotate_monthly_challenge is idempotent for the same month', async () => {
  const first = await pool.query('SELECT rotate_monthly_challenge() AS code');
  const second = await pool.query('SELECT rotate_monthly_challenge() AS code');
  assert.equal(first.rows[0].code, second.rows[0].code);

  const rotationRows = await pool.query(
    `SELECT COUNT(*)::INTEGER AS n FROM monthly_challenge_rotation WHERE month_start = date_trunc('month', CURRENT_DATE)::DATE`
  );
  assert.equal(rotationRows.rows[0].n, 1);
});

test('assign_monthly_challenge gives a member exactly one row for the current month, even if called twice', async () => {
  const userId = await makeUser();
  await pool.query('SELECT assign_monthly_challenge($1)', [userId]);
  await pool.query('SELECT assign_monthly_challenge($1)', [userId]);

  const rows = await pool.query(
    `SELECT um.*, (um.assigned_date = date_trunc('month', CURRENT_DATE)::DATE) AS is_this_month
       FROM user_missions um JOIN missions m ON m.code = um.mission_code
      WHERE um.user_id = $1 AND m.mission_type IN ('monthly', 'challenge')`,
    [userId]
  );
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].is_this_month, true);
});

test('completing a monthly challenge awards points and marks it done, independent of daily/weekly missions on the same action', async () => {
  const userId = await makeUser();
  await pool.query(`UPDATE monthly_challenge_rotation SET mission_code = 'challenge_recognise20' WHERE month_start = date_trunc('month', CURRENT_DATE)::DATE`);
  await pool.query('SELECT assign_monthly_challenge($1)', [userId]);

  for (let i = 0; i < 20; i++) {
    const target = await makeUser();
    await pool.query(`SELECT * FROM process_recognition($1, $2, 'helpful')`, [userId, target]);
    await pool.query(`SELECT update_mission_progress($1, 'recognition_give')`, [userId]);
  }

  const mission = await pool.query(
    `SELECT progress_count, is_completed FROM user_missions
      WHERE user_id = $1 AND mission_code = 'challenge_recognise20'`,
    [userId]
  );
  assert.equal(mission.rows[0].progress_count, 20);
  assert.equal(mission.rows[0].is_completed, true);
});

test('a monthly challenge does not complete from a WEEKLY mission row on the same action code', async () => {
  const userId = await makeUser();
  // This file never otherwise triggers weekly rotation, so
  // weekly_mission_rotation has no row for the current week yet — rotate
  // first so the UPDATE below has something to target (an UPDATE against
  // a WHERE clause matching nothing is a silent no-op, not an error).
  await pool.query('SELECT rotate_weekly_mission()');
  await pool.query(`UPDATE weekly_mission_rotation SET mission_code = 'weekly_recognise5' WHERE week_start = date_trunc('week', CURRENT_DATE)::DATE`);
  await pool.query(`UPDATE monthly_challenge_rotation SET mission_code = 'challenge_recognise20' WHERE month_start = date_trunc('month', CURRENT_DATE)::DATE`);
  await pool.query('SELECT assign_weekly_mission($1)', [userId]);
  await pool.query('SELECT assign_monthly_challenge($1)', [userId]);

  const target = await makeUser();
  await pool.query(`SELECT * FROM process_recognition($1, $2, 'outstanding')`, [userId, target]);
  await pool.query(`SELECT update_mission_progress($1, 'recognition_give')`, [userId]);

  const weekly = await pool.query(
    `SELECT progress_count FROM user_missions WHERE user_id = $1 AND mission_code = 'weekly_recognise5'`, [userId]
  );
  const monthly = await pool.query(
    `SELECT progress_count FROM user_missions WHERE user_id = $1 AND mission_code = 'challenge_recognise20'`, [userId]
  );
  assert.equal(weekly.rows[0].progress_count, 1);
  assert.equal(monthly.rows[0].progress_count, 1);
});

test('re-running every migration is idempotent — rotation history and challenge seeds stay stable', async () => {
  const before1 = await pool.query('SELECT COUNT(*)::INTEGER AS n FROM monthly_challenge_rotation');
  await runMigrations();
  const after1 = await pool.query('SELECT COUNT(*)::INTEGER AS n FROM monthly_challenge_rotation');
  assert.equal(before1.rows[0].n, after1.rows[0].n);

  const challengeCount = await pool.query(`SELECT COUNT(*)::INTEGER AS n FROM missions WHERE mission_type = 'challenge'`);
  // Was 2 when two challenges were seeded. The catalogue grows, so this
  // asserts the seed SURVIVES a re-run rather than pinning its size.
  assert.ok(challengeCount.rows[0].n >= 2);
});
