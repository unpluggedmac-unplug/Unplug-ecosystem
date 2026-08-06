// Participation Engine — Stage K: Streak tiers, over real PostgreSQL.
// Drives real streak progress through mission_complete (the action Stage K
// flips counts_for_streak on) via award_points() directly, same approach
// as every other stage's tests in this suite.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-streaktiers-'));
const port = 13600 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

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

let _nextUserId = 8000;
async function makeUser() {
  const id = _nextUserId++;
  await pool.query(`INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', 'member') ON CONFLICT DO NOTHING`, [id, `streak${id}@test.com`]);
  return id;
}

// Awards mission_complete for a specific date by temporarily faking
// CURRENT_DATE via an explicit earned_at is not how award_points() derives
// v_today (it uses CURRENT_DATE inside the function, not a parameter), so
// to simulate a multi-day streak in one test run we call update_streak()
// directly with an explicit date, then check_and_award_streak_tier() —
// which is exactly what award_points() itself does internally, just
// isolated from CURRENT_DATE so a test can walk multiple days without
// waiting for real time to pass.
async function advanceStreak(userId, date) {
  await pool.query('SELECT update_streak($1, $2)', [userId, date]);
  await pool.query('SELECT check_and_award_streak_tier($1)', [userId]);
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
  await pg.stop();
});

test('mission_complete has counts_for_streak enabled — the flag is not dead weight', async () => {
  const result = await pool.query(`SELECT counts_for_streak FROM participation_actions WHERE code = 'mission_complete'`);
  assert.equal(result.rows[0].counts_for_streak, true);
});

test('a single day streak awards no tier — the first tier needs 3 days', async () => {
  const userId = await makeUser();
  await advanceStreak(userId, '2026-01-01');

  const streak = await pool.query('SELECT current_streak_days, highest_tier_code FROM user_streaks WHERE user_id = $1', [userId]);
  assert.equal(streak.rows[0].current_streak_days, 1);
  assert.equal(streak.rows[0].highest_tier_code, null);
});

test('reaching 3 consecutive days awards the spark tier and its bonus points', async () => {
  const userId = await makeUser();
  await advanceStreak(userId, '2026-01-01');
  await advanceStreak(userId, '2026-01-02');
  await advanceStreak(userId, '2026-01-03');

  const streak = await pool.query('SELECT current_streak_days, highest_tier_code FROM user_streaks WHERE user_id = $1', [userId]);
  assert.equal(streak.rows[0].current_streak_days, 3);
  assert.equal(streak.rows[0].highest_tier_code, 'spark');

  const points = await pool.query(
    `SELECT total_points FROM participation_points WHERE user_id = $1 AND action_code = 'streak_tier_bonus'`,
    [userId]
  );
  assert.equal(points.rows.length, 1);
  assert.equal(points.rows[0].total_points, 10); // spark's seeded bonus_points

  const notif = await pool.query(`SELECT 1 AS found FROM notifications WHERE user_id = $1 AND type = 'streak_tier'`, [userId]);
  assert.equal(notif.rows.length, 1);
});

test('does not re-award the same tier on a later day that has not reached the next one', async () => {
  const userId = await makeUser();
  await advanceStreak(userId, '2026-01-01');
  await advanceStreak(userId, '2026-01-02');
  await advanceStreak(userId, '2026-01-03'); // -> spark
  await advanceStreak(userId, '2026-01-04'); // still short of flame (7 days)

  const points = await pool.query(
    `SELECT COUNT(*)::INTEGER AS n FROM participation_points WHERE user_id = $1 AND action_code = 'streak_tier_bonus'`,
    [userId]
  );
  assert.equal(points.rows[0].n, 1); // still just the one spark award
});

test('crossing multiple tier boundaries between checks only awards the highest one reached', async () => {
  const userId = await makeUser();
  // Build the streak day-by-day without checking tiers in between (mirrors
  // a real gap where the scheduler or a login didn't fire every single
  // day), then run the tier check once at day 10 — past spark(3) AND
  // flame(7) in one jump.
  const days = ['2026-02-01', '2026-02-02', '2026-02-03', '2026-02-04', '2026-02-05',
                '2026-02-06', '2026-02-07', '2026-02-08', '2026-02-09', '2026-02-10'];
  for (const d of days) {
    await pool.query('SELECT update_streak($1, $2)', [userId, d]);
  }
  await pool.query('SELECT check_and_award_streak_tier($1)', [userId]);

  const streak = await pool.query('SELECT current_streak_days, highest_tier_code FROM user_streaks WHERE user_id = $1', [userId]);
  assert.equal(streak.rows[0].current_streak_days, 10);
  assert.equal(streak.rows[0].highest_tier_code, 'flame'); // highest tier <= 10 days, not spark

  const points = await pool.query(
    `SELECT COUNT(*)::INTEGER AS n FROM participation_points WHERE user_id = $1 AND action_code = 'streak_tier_bonus'`,
    [userId]
  );
  assert.equal(points.rows[0].n, 1); // one award, for flame — spark was skipped, not double-paid
});

test('a broken streak resets highest_tier_code, so the next streak earns tiers again from the bottom', async () => {
  const userId = await makeUser();
  await advanceStreak(userId, '2026-03-01');
  await advanceStreak(userId, '2026-03-02');
  await advanceStreak(userId, '2026-03-03'); // -> spark

  // Skip several days — breaks the streak back to 1.
  await advanceStreak(userId, '2026-03-10');

  const streak = await pool.query('SELECT current_streak_days, highest_tier_code FROM user_streaks WHERE user_id = $1', [userId]);
  assert.equal(streak.rows[0].current_streak_days, 1);
  assert.equal(streak.rows[0].highest_tier_code, null);
});

test('an action awarded through award_points() with counts_for_streak = FALSE never touches the streak', async () => {
  const userId = await makeUser();
  await pool.query(`SELECT * FROM award_points($1, 'recognition_receive')`, [userId]);
  const streak = await pool.query('SELECT * FROM user_streaks WHERE user_id = $1', [userId]);
  assert.equal(streak.rows.length, 0); // no row ever created
});

test('re-running every migration is idempotent — the seven streak tiers stay stable', async () => {
  await runMigrations();
  const tiers = await pool.query('SELECT COUNT(*)::INTEGER AS n FROM streak_tiers');
  assert.equal(tiers.rows[0].n, 7);
});
