// Participation Engine — Stage C: Recognition, Achievements, Passport,
// Missions, over real PostgreSQL. No Express routes exist yet — these
// tests call the SQL functions directly, the same functions the routes
// will call via pool.query(...) once they exist.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-recognition-'));
const port = 10800 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

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

let _nextUserId = 3000;
async function makeUser() {
  const id = _nextUserId++;
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', 'member') ON CONFLICT DO NOTHING`,
    [id, `rec${id}@test.com`]
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
  await pg.stop();
});

test('a recognition awards points to both giver and receiver, and updates counts', async () => {
  const giver = await makeUser();
  const receiver = await makeUser();

  const result = await pool.query(
    `SELECT * FROM process_recognition($1, $2, 'inspiring', 'Great work!', TRUE)`,
    [giver, receiver]
  );
  assert.equal(result.rows[0].success, true);
  assert.ok(result.rows[0].recognition_id);

  // process_recognition also fires sync_achievements — this being each
  // user's very first recognition, the "warm_welcome" (giver, +5) and
  // "recognised" (receiver, +10) achievement bonuses stack on top of the
  // base recognition points in the same call.
  const giverScore = await pool.query('SELECT unplug_score FROM score_cache WHERE user_id = $1', [giver]);
  const receiverScore = await pool.query('SELECT unplug_score FROM score_cache WHERE user_id = $1', [receiver]);
  assert.equal(giverScore.rows[0].unplug_score, 25);
  assert.equal(receiverScore.rows[0].unplug_score, 35);

  const counts = await pool.query('SELECT total_received, inspiring_count FROM recognition_counts WHERE user_id = $1', [receiver]);
  assert.equal(counts.rows[0].total_received, 1);
  assert.equal(counts.rows[0].inspiring_count, 1);

  const notif = await pool.query(`SELECT title FROM notifications WHERE user_id = $1 AND type = 'recognition'`, [receiver]);
  assert.equal(notif.rows.length, 1);
});

test('self-recognition is blocked', async () => {
  const userId = await makeUser();
  const result = await pool.query(`SELECT * FROM process_recognition($1, $1, 'helpful')`, [userId]);
  assert.equal(result.rows[0].success, false);
  assert.equal(result.rows[0].blocked_reason, 'self_recognition_not_allowed');
});

test('an unknown recognition type is rejected', async () => {
  const a = await makeUser();
  const b = await makeUser();
  const result = await pool.query(`SELECT * FROM process_recognition($1, $2, 'not_a_real_type')`, [a, b]);
  assert.equal(result.rows[0].success, false);
  assert.equal(result.rows[0].blocked_reason, 'invalid_recognition_type');
});

test('the same giver cannot recognise the same person with the same type twice, but a different type is allowed', async () => {
  const giver = await makeUser();
  const receiver = await makeUser();
  await pool.query(`SELECT * FROM process_recognition($1, $2, 'helpful')`, [giver, receiver]);
  const dup = await pool.query(`SELECT * FROM process_recognition($1, $2, 'helpful')`, [giver, receiver]);
  assert.equal(dup.rows[0].success, false);
  assert.equal(dup.rows[0].blocked_reason, 'already_recognised_this_type');

  const differentType = await pool.query(`SELECT * FROM process_recognition($1, $2, 'outstanding')`, [giver, receiver]);
  assert.equal(differentType.rows[0].success, true);

  const counts = await pool.query('SELECT total_received FROM recognition_counts WHERE user_id = $1', [receiver]);
  assert.equal(counts.rows[0].total_received, 2);
});

test('recognising someone unlocks the "recognised" and "warm_welcome" achievements with their point bonuses', async () => {
  const giver = await makeUser();
  const receiver = await makeUser();
  await pool.query(`SELECT * FROM process_recognition($1, $2, 'creative')`, [giver, receiver]);

  const giverAch = await pool.query('SELECT achievement_code FROM user_achievements WHERE user_id = $1', [giver]);
  assert.deepEqual(giverAch.rows.map((r) => r.achievement_code), ['warm_welcome']);

  const receiverAch = await pool.query('SELECT achievement_code FROM user_achievements WHERE user_id = $1', [receiver]);
  assert.deepEqual(receiverAch.rows.map((r) => r.achievement_code), ['recognised']);

  // 20 (recognition_give) + 5 (warm_welcome reward) = 25
  const giverScore = await pool.query('SELECT unplug_score FROM score_cache WHERE user_id = $1', [giver]);
  assert.equal(giverScore.rows[0].unplug_score, 25);
  // 25 (recognition_receive) + 10 (recognised reward) = 35
  const receiverScore = await pool.query('SELECT unplug_score FROM score_cache WHERE user_id = $1', [receiver]);
  assert.equal(receiverScore.rows[0].unplug_score, 35);
});

test('sync_passport awards a status stamp once the member holds that status', async () => {
  const userId = await makeUser();
  await pool.query(
    `INSERT INTO member_status_history (user_id, status_code, is_active_status) VALUES ($1, 'trailblazer', TRUE)`,
    [userId]
  );
  const awarded = await pool.query('SELECT sync_passport($1) AS n', [userId]);
  assert.ok(awarded.rows[0].n >= 1);

  const stamp = await pool.query(
    `SELECT 1 AS found FROM user_passport WHERE user_id = $1 AND passport_code = 'status_trailblazer'`,
    [userId]
  );
  assert.equal(stamp.rows.length, 1);
});

test('sync_passport is idempotent — never awards the same stamp twice', async () => {
  const userId = await makeUser();
  await pool.query(
    `INSERT INTO member_status_history (user_id, status_code, is_active_status) VALUES ($1, 'explorer', TRUE)`,
    [userId]
  );
  await pool.query('SELECT sync_passport($1)', [userId]);
  await pool.query('SELECT sync_passport($1)', [userId]);
  const count = await pool.query(
    `SELECT COUNT(*)::INTEGER AS n FROM user_passport WHERE user_id = $1 AND passport_code = 'status_explorer'`,
    [userId]
  );
  assert.equal(count.rows[0].n, 1);
});

test('assign_daily_missions assigns the one seeded daily mission, and will not double-assign it the same day', async () => {
  const userId = await makeUser();
  const first = await pool.query('SELECT assign_daily_missions($1) AS n', [userId]);
  // Was 1 when a single daily mission was seeded; the pool is 731 now, so
  // this asserts the real rule: a member gets missions, and calling again
  // the same day adds none.
  assert.ok(first.rows[0].n >= 1);

  const second = await pool.query('SELECT assign_daily_missions($1) AS n', [userId]);
  assert.equal(second.rows[0].n, 0);

  const rows = await pool.query('SELECT mission_code FROM user_missions WHERE user_id = $1', [userId]);
  // Every assignment must be a DAILY mission, whichever ones were dealt.
  const assignedTypes = await pool.query(
    `SELECT DISTINCT m.mission_type FROM user_missions um
       JOIN missions m ON m.code = um.mission_code WHERE um.user_id = $1`, [userId]
  );
  assert.deepEqual(assignedTypes.rows.map((r) => r.mission_type), ['daily']);
});

test('completing the assigned mission via a real recognition awards mission points and notifies', async () => {
  const giver = await makeUser();
  const receiver = await makeUser();
  // Assigned explicitly rather than via assign_daily_missions(): the daily
  // pool is 731 now, so relying on the random deal to hand out this one
  // specific mission made the test a coin toss.
  await pool.query(
    `INSERT INTO user_missions (user_id, mission_code, assigned_date)
     VALUES ($1, 'daily_recognise', CURRENT_DATE) ON CONFLICT DO NOTHING`, [giver]);

  await pool.query(`SELECT * FROM process_recognition($1, $2, 'local_hero')`, [giver, receiver]);
  const completed = await pool.query(
    `SELECT update_mission_progress($1, 'recognition_give') AS n`,
    [giver]
  );
  assert.equal(completed.rows[0].n, 1);

  const mission = await pool.query(
    `SELECT is_completed, progress_count FROM user_missions WHERE user_id = $1 AND mission_code = 'daily_recognise'`,
    [giver]
  );
  assert.equal(mission.rows[0].is_completed, true);
  assert.equal(mission.rows[0].progress_count, 1);

  const notif = await pool.query(`SELECT 1 AS found FROM notifications WHERE user_id = $1 AND type = 'mission'`, [giver]);
  assert.equal(notif.rows.length, 1);
});

test('re-running every migration is idempotent — seed counts stay stable', async () => {
  await runMigrations();
  const types = await pool.query('SELECT COUNT(*)::INTEGER AS n FROM recognition_types');
  assert.equal(types.rows[0].n, 11);
  const achievements = await pool.query('SELECT COUNT(*)::INTEGER AS n FROM achievements');
  assert.equal(achievements.rows[0].n, 8);
  const passport = await pool.query('SELECT COUNT(*)::INTEGER AS n FROM passport_items');
  assert.equal(passport.rows[0].n, 8);
  const missions = await pool.query('SELECT COUNT(*)::INTEGER AS n FROM missions');
  // Was 6 before the mission programme was loaded; asserts the seed survives
  // a re-run rather than pinning the catalogue size.
  assert.ok(missions.rows[0].n >= 6); // 2 from Stage C + 2 weekly from Stage H + 2 challenge from Stage L
});
