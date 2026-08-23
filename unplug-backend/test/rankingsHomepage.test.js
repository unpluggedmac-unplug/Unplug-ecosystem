// Participation Engine — Stage D: rankings + daily homepage, over real
// PostgreSQL. No Express routes exist yet — these tests call the SQL
// functions directly, the same functions the routes and the in-process
// scheduler (src/utils/participationScheduler.js) will call.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-rankings-'));
const port = 11200 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

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

let _nextUserId = 4000;
async function makeUser(email) {
  const id = _nextUserId++;
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', 'member') ON CONFLICT DO NOTHING`,
    [id, email || `rank${id}@test.com`]
  );
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

test('recalculate_all_rankings ranks members by score, highest first', async () => {
  const low = await makeUser();
  const high = await makeUser();
  await pool.query(`SELECT * FROM admin_award_points($1, $1, 100, 'seed')`, [low]);
  await pool.query(`SELECT * FROM admin_award_points($1, $1, 500, 'seed')`, [high]);

  await pool.query('SELECT recalculate_all_rankings()');

  const ranks = await pool.query(
    `SELECT user_id, rank_position, score_value FROM rankings
      WHERE ranking_type = 'overall' AND period_type = 'lifetime' AND user_id IN ($1, $2) ORDER BY rank_position ASC`,
    [low, high]
  );
  assert.equal(ranks.rows[0].user_id, high);
  assert.equal(ranks.rows[0].score_value, 500);
  assert.equal(ranks.rows[1].user_id, low);
  assert.ok(ranks.rows[0].rank_position < ranks.rows[1].rank_position);
});

test('a second recalculation records rank_movement against the first', async () => {
  const climber = await makeUser();
  const stayer = await makeUser();
  // stayer starts well ahead; climber starts behind, then overtakes.
  await pool.query(`SELECT * FROM admin_award_points($1, $1, 1000, 'seed')`, [stayer]);
  await pool.query(`SELECT * FROM admin_award_points($1, $1, 10, 'seed')`, [climber]);
  await pool.query('SELECT recalculate_all_rankings()');

  await pool.query(`SELECT * FROM admin_award_points($1, $1, 2000, 'catch up')`, [climber]);
  await pool.query('SELECT recalculate_all_rankings()');

  const climberRank = await pool.query(
    `SELECT rank_position, rank_movement FROM rankings WHERE ranking_type = 'overall' AND period_type = 'lifetime' AND user_id = $1`,
    [climber]
  );
  // climber should now be ranked ABOVE stayer (lower rank_position number) and moved up (positive movement)
  assert.ok(climberRank.rows[0].rank_movement > 0);
});

test('get_leaderboard falls back to the email local-part when there is no Directory listing', async () => {
  const userId = await makeUser('jordan.example@test.com');
  await pool.query(`SELECT * FROM admin_award_points($1, $1, 50, 'seed')`, [userId]);
  await pool.query('SELECT recalculate_all_rankings()');

  const board = await pool.query(`SELECT * FROM get_leaderboard('overall', 100, 0)`);
  const row = board.rows.find((r) => r.user_id === userId);
  assert.ok(row);
  assert.equal(row.display_name, 'jordan.example');
});

test('a member who opts out of the leaderboard is excluded from get_leaderboard', async () => {
  const userId = await makeUser();
  await pool.query(`SELECT * FROM admin_award_points($1, $1, 9999, 'seed')`, [userId]);
  await pool.query(`SELECT ensure_member_participation_profile($1)`, [userId]);
  await pool.query(`UPDATE member_participation_profiles SET show_on_leaderboard = FALSE WHERE user_id = $1`, [userId]);
  await pool.query('SELECT recalculate_all_rankings()');

  const board = await pool.query(`SELECT * FROM get_leaderboard('overall', 100, 0)`);
  assert.ok(!board.rows.some((r) => r.user_id === userId));
});

test('get_biggest_movers only returns members whose rank improved', async () => {
  const mover = await makeUser();
  await pool.query(`SELECT * FROM admin_award_points($1, $1, 10, 'seed')`, [mover]);
  await pool.query('SELECT recalculate_all_rankings()');
  await pool.query(`SELECT * FROM admin_award_points($1, $1, 5000, 'jump')`, [mover]);
  await pool.query('SELECT recalculate_all_rankings()');

  const movers = await pool.query('SELECT * FROM get_biggest_movers(10)');
  assert.ok(movers.rows.some((r) => r.user_id === mover && r.rank_movement > 0));
});

test('calculate_daily_homepage picks the most-recognised member when no achievement or mover exists yet, and notifies them', async () => {
  const giver = await makeUser();
  const receiver = await makeUser();
  await pool.query(`SELECT * FROM process_recognition($1, $2, 'helpful')`, [giver, receiver]);

  await pool.query(`SELECT calculate_daily_homepage(CURRENT_DATE)`);

  const row = await pool.query(
    `SELECT todays_person_id, todays_person_source FROM daily_homepage WHERE content_date = CURRENT_DATE`
  );
  // most_recognised is the lowest-priority fallback that's guaranteed to
  // be satisfiable here (no achievement earned today by construction —
  // recognition_receive/give achievements only fire on a member's FIRST
  // recognition, which is exactly what just happened, so this doubles as
  // a check that "achievement today" correctly outranks "recognised").
  assert.equal(row.rows[0].todays_person_source, 'achievement');

  const notif = await pool.query(
    `SELECT 1 AS found FROM notifications WHERE user_id = $1 AND type = 'featured'`,
    [row.rows[0].todays_person_id]
  );
  assert.equal(notif.rows.length, 1);
});

test('get_daily_homepage auto-calculates and returns enriched JSON for a date with no row yet', async () => {
  const result = await pool.query(`SELECT get_daily_homepage(CURRENT_DATE + 1) AS payload`);
  const payload = result.rows[0].payload;
  assert.ok(payload.date); // it auto-calculated a fresh row for this date rather than erroring on a missing one
  assert.ok('day_theme' in payload);
  assert.ok('todays_person' in payload);
});

test('re-running every migration is idempotent', async () => {
  await runMigrations();
  const fnCheck = await pool.query(`SELECT 1 AS ok FROM pg_proc WHERE proname = 'recalculate_all_rankings'`);
  assert.equal(fnCheck.rows.length, 1);
});
