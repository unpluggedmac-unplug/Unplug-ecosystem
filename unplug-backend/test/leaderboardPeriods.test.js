// Participation Engine — Stage Q: weekly/monthly leaderboard scopes,
// over real PostgreSQL. Exercises the SQL functions directly, same
// approach as every other stage's tests in this suite.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-leaderboardperiods-'));
const port = 15600 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

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

let _nextUserId = 13000;
async function makeUser() {
  const id = _nextUserId++;
  await pool.query(`INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', 'member') ON CONFLICT DO NOTHING`, [id, `lb${id}@test.com`]);
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

test('get_current_period_value returns a stable ISO-week label for weekly and YYYY-MM for monthly', async () => {
  const weekly = await pool.query(`SELECT get_current_period_value('weekly') AS v`);
  const monthly = await pool.query(`SELECT get_current_period_value('monthly') AS v`);
  assert.match(weekly.rows[0].v, /^\d{4}-W\d{2}$/);
  assert.match(monthly.rows[0].v, /^\d{4}-\d{2}$/);
});

test('recalculate_period_ranking (weekly, overall) ranks by points earned this week only, ignoring older points', async () => {
  const high = await makeUser();
  const low = await makeUser();
  const outOfWindow = await makeUser();

  await pool.query(`SELECT award_points($1, 'achievement_earned', NULL, NULL, NULL, 100)`, [high]);
  await pool.query(`SELECT award_points($1, 'achievement_earned', NULL, NULL, NULL, 10)`, [low]);
  // Simulate points earned before this week — outOfWindow should not
  // appear in the weekly ranking despite having the most points overall.
  await pool.query(`SELECT award_points($1, 'achievement_earned', NULL, NULL, NULL, 1000)`, [outOfWindow]);
  await pool.query(`UPDATE participation_points SET earned_at = now() - INTERVAL '20 days' WHERE user_id = $1`, [outOfWindow]);

  await pool.query(`SELECT recalculate_period_ranking('overall', 'weekly')`);

  const result = await pool.query(`SELECT user_id, score_value FROM get_leaderboard('overall', 50, 0, 'weekly', get_current_period_value('weekly'))`);
  const ids = result.rows.map((r) => r.user_id);
  assert.ok(!ids.includes(outOfWindow));
  assert.equal(ids[0], high); // highest THIS WEEK ranks first
  assert.equal(ids[1], low);
});

test('recalculate_period_ranking (monthly, recognition) only sums recognition_give/receive, not other actions', async () => {
  const a = await makeUser();
  const b = await makeUser();
  await pool.query(`SELECT * FROM process_recognition($1, $2, 'helpful')`, [a, b]);
  // A also earns unrelated points that should NOT count toward the
  // recognition-scoped ranking.
  await pool.query(`SELECT award_points($1, 'achievement_earned', NULL, NULL, NULL, 500)`, [a]);

  await pool.query(`SELECT recalculate_period_ranking('recognition', 'monthly')`);

  const result = await pool.query(`SELECT user_id, score_value FROM get_leaderboard('recognition', 50, 0, 'monthly', get_current_period_value('monthly'))`);
  const aRow = result.rows.find((r) => r.user_id === a);
  assert.equal(aRow.score_value, 20); // recognition_give's base_points, not 520
});

test('a member who opts out of the leaderboard is excluded from period rankings too', async () => {
  const userId = await makeUser();
  await pool.query('SELECT ensure_member_participation_profile($1)', [userId]);
  await pool.query(`UPDATE member_participation_profiles SET show_on_leaderboard = FALSE WHERE user_id = $1`, [userId]);
  await pool.query(`SELECT award_points($1, 'achievement_earned', NULL, NULL, NULL, 999)`, [userId]);
  await pool.query(`SELECT recalculate_period_ranking('overall', 'weekly')`);

  const result = await pool.query(`SELECT user_id FROM get_leaderboard('overall', 50, 0, 'weekly', get_current_period_value('weekly'))`);
  assert.ok(!result.rows.map((r) => r.user_id).includes(userId));
});

test('get_leaderboard still works with only the old 3 arguments (backward compatible default)', async () => {
  const result = await pool.query(`SELECT * FROM get_leaderboard('overall', 5, 0)`);
  assert.ok(Array.isArray(result.rows)); // does not error — defaults to lifetime/all-time
});

test('recalculate_all_rankings populates weekly and monthly rankings, not just lifetime', async () => {
  const userId = await makeUser();
  await pool.query(`SELECT award_points($1, 'achievement_earned', NULL, NULL, NULL, 50)`, [userId]);
  await pool.query('SELECT recalculate_all_rankings()');

  const counts = await pool.query(
    `SELECT period_type, COUNT(*)::INTEGER AS n FROM rankings WHERE ranking_type = 'overall' GROUP BY period_type ORDER BY period_type`
  );
  const types = counts.rows.map((r) => r.period_type);
  assert.ok(types.includes('lifetime'));
  assert.ok(types.includes('weekly'));
  assert.ok(types.includes('monthly'));
});
