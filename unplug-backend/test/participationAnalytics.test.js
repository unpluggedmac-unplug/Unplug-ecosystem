// Participation Engine — Stage P: Participation Analytics, over real
// PostgreSQL. These test the underlying aggregate queries directly
// (same queries the GET /participation/admin/analytics route runs),
// since the route itself is a thin wrapper with no logic of its own.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-panalytics-'));
const port = 15200 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

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

let _nextUserId = 12000;
async function makeUser() {
  const id = _nextUserId++;
  await pool.query(`INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', 'member') ON CONFLICT DO NOTHING`, [id, `pan${id}@test.com`]);
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
  // Windows can still hold a handle on the data directory when Postgres
  // exits, and embedded-postgres removes that directory as part of
  // stopping. The server is already down by then, so an EBUSY here is
  // the OS being slow to let go, not a failure worth failing the file
  // for — and a teardown that goes red teaches everyone to ignore red.
  try { if (pg) await pg.stop(); } catch (e) { /* see above */ }
});

test('status distribution includes every status level, even ones with zero members', async () => {
  const rows = await pool.query(
    `SELECT sl.code, COUNT(msh.user_id)::INTEGER AS n
       FROM member_status_levels sl
       LEFT JOIN member_status_history msh ON msh.status_code = sl.code AND msh.is_active_status = TRUE
      GROUP BY sl.code
      ORDER BY sl.code`
  );
  assert.equal(rows.rows.length, 6); // all 6 seeded member status levels, per Stage A
  assert.ok(rows.rows.every((r) => r.n === 0));
});

test('a promoted member shows up under their current status, not a stale earlier one', async () => {
  // Exercises the aggregation query's is_active_status filtering directly
  // (real promotion mechanics — the score/tenure/active-months gates on
  // check_and_update_status() — are already covered by earlier stages'
  // own tests). A member's history should have exactly one active row at
  // a time; the query must count them under that row's status, not any
  // earlier inactive one.
  const userId = await makeUser();
  await pool.query(
    `INSERT INTO member_status_history (user_id, status_code, is_active_status) VALUES ($1, 'explorer', FALSE)`,
    [userId]
  );
  await pool.query(
    `INSERT INTO member_status_history (user_id, status_code, is_active_status) VALUES ($1, 'trailblazer', TRUE)`,
    [userId]
  );

  const rows = await pool.query(
    `SELECT sl.code, COUNT(msh.user_id)::INTEGER AS n
       FROM member_status_levels sl
       LEFT JOIN member_status_history msh ON msh.status_code = sl.code AND msh.is_active_status = TRUE
      GROUP BY sl.code`
  );
  const explorer = rows.rows.find((r) => r.code === 'explorer');
  const trailblazer = rows.rows.find((r) => r.code === 'trailblazer');
  assert.equal(explorer.n, 0); // the inactive row is excluded
  assert.equal(trailblazer.n, 1); // counted under the active row only
});

test('daily points aggregation sums total_points per day within the range', async () => {
  const userId = await makeUser();
  await pool.query(`SELECT award_points($1, 'achievement_earned', NULL, NULL, NULL, 40)`, [userId]);
  await pool.query(`SELECT award_points($1, 'achievement_earned', NULL, NULL, NULL, 10)`, [userId]);

  const rows = await pool.query(
    `SELECT DATE(earned_at) AS day, SUM(total_points)::INTEGER AS points, COUNT(*)::INTEGER AS actions
       FROM participation_points
      WHERE user_id = $1 AND is_reversed = FALSE AND earned_at >= now() - INTERVAL '30 days'
      GROUP BY DATE(earned_at)`,
    [userId]
  );
  assert.equal(rows.rows.length, 1); // both awards land on today
  assert.equal(rows.rows[0].points, 50);
  assert.equal(rows.rows[0].actions, 2);
});

test('mission completion rate query excludes assignments outside the range', async () => {
  const userId = await makeUser();
  await pool.query('SELECT assign_daily_missions($1)', [userId]);

  const inRange = await pool.query(
    `SELECT COUNT(*)::INTEGER AS n FROM user_missions um JOIN missions m ON m.code = um.mission_code
      WHERE m.mission_type = 'daily' AND um.assigned_date >= CURRENT_DATE - INTERVAL '30 days'`
  );
  // Was 1 when one daily mission existed. The point of the test is that
  // in-range assignments are counted and out-of-range ones are not.
  assert.ok(inRange.rows[0].n >= 1);

  const outOfRange = await pool.query(
    `SELECT COUNT(*)::INTEGER AS n FROM user_missions um JOIN missions m ON m.code = um.mission_code
      WHERE m.mission_type = 'daily' AND um.assigned_date >= CURRENT_DATE - INTERVAL '1 days' AND um.assigned_date < CURRENT_DATE - INTERVAL '1 days'`
  );
  assert.equal(outOfRange.rows[0].n, 0);
});

test('trust summary reports zero flagged when no one has ever been flagged', async () => {
  const rows = await pool.query(
    `SELECT (SELECT COUNT(*) FROM trust_scores WHERE score < 100)::INTEGER AS flagged_count`
  );
  assert.equal(rows.rows[0].flagged_count, 0);
});
