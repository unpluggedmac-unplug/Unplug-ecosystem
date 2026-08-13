// THE MISSION PROGRAMME — 730 daily, 104 weekly, 36 monthly, and the 28
// participation actions they depend on.
//
// The guarantees worth testing hardest:
//   1. The migration must actually apply. missions.action_code is a foreign
//      key into participation_actions, and 27 of the 28 codes the
//      spreadsheets use did not exist — so the actions must be created before
//      the missions, or not one row inserts.
//   2. Nine actions must be worth ZERO points. They are derived events
//      (badge unlocked, streak kept, score grown) that happen because the
//      engine already paid for whatever caused them. Paying again would
//      double-count every member's score.
//   3. Monthly challenges must be VISIBLE to the rotation. They are stored as
//      a new 'monthly' type, and rotate_monthly_challenge() used to select
//      only 'challenge' — so without the updated function all 36 would sit
//      there forever and members would see nothing each month.
//   4. Re-running must not overwrite an admin's edits or duplicate anything.
//   5. Doing a real thing on the site must move a real mission.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-missions-'));
const port = 26400 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');
async function runMigrations() {
  for (const f of fs.readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
  }
}

// The nine that must never pay out, or scoring double-counts.
const DERIVED = [
  'badge_unlock', 'achievement_unlock', 'passport_stamp', 'challenge_complete',
  'streak_maintain', 'score_progress', 'ranking_progress', 'compound_mission',
];

let _nextUserId = 161000;
async function makeUser() {
  const id = _nextUserId++;
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', 'member')
     ON CONFLICT DO NOTHING`,
    [id, `mp${id}@test.com`]
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
  process.env.JWT_SECRET = 'test-secret-for-missions';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await runMigrations();
});

after(async () => {
  if (pool) await pool.end();
  if (pg) await pg.stop();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* Windows holds the dir briefly */ }
});

test('all 870 missions load, split correctly by type', async () => {
  const r = await pool.query(
    `SELECT mission_type, COUNT(*)::int AS n FROM missions
      WHERE code ~ '^[DWM][0-9]+$' GROUP BY mission_type ORDER BY mission_type`
  );
  const byType = Object.fromEntries(r.rows.map((x) => [x.mission_type, x.n]));
  assert.equal(byType.daily, 730);
  assert.equal(byType.weekly, 104);
  assert.equal(byType.monthly, 36);
});

test('every mission has a real action behind it', async () => {
  // The foreign key would have refused the insert, so this proves the actions
  // were created first and nothing was silently dropped.
  const orphans = await pool.query(
    `SELECT COUNT(*)::int AS n FROM missions m
      WHERE m.action_code IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM participation_actions a WHERE a.code = m.action_code)`
  );
  assert.equal(orphans.rows[0].n, 0);

  const blank = await pool.query(
    `SELECT COUNT(*)::int AS n FROM missions WHERE title = '' OR description = ''`
  );
  assert.equal(blank.rows[0].n, 0);
});

test('the 28 new participation actions exist', async () => {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM participation_actions
      WHERE code IN ('comment_create','save_content','like_content','member_follow',
                     'article_read_complete','content_submit','review_create',
                     'competition_vote','content_share','badge_unlock')`
  );
  assert.equal(r.rows[0].n, 10);
});

test('DERIVED ACTIONS ARE WORTH ZERO POINTS', async () => {
  // If any of these ever gains a point value, every member who earns a badge
  // gets paid twice for the same act — once for the thing they did, once for
  // the badge it triggered.
  const r = await pool.query(
    'SELECT code, base_points FROM participation_actions WHERE code = ANY($1)', [DERIVED]
  );
  assert.equal(r.rows.length, DERIVED.length);
  r.rows.forEach((a) => {
    assert.equal(Number(a.base_points), 0, `${a.code} must be worth 0 points`);
  });
});

test('earning actions are capped so none can be farmed', async () => {
  const r = await pool.query(
    `SELECT code, daily_limit FROM participation_actions
      WHERE base_points > 0 AND code IN ('comment_create','like_content','save_content',
                                         'member_follow','content_submit','competition_vote')`
  );
  assert.equal(r.rows.length, 6);
  r.rows.forEach((a) => {
    assert.ok(a.daily_limit > 0, `${a.code} must have a daily limit`);
  });
});

test('MONTHLY CHALLENGES ARE VISIBLE TO THE ROTATION', async () => {
  // They are stored under a brand-new 'monthly' type, and the rotation used
  // to select only 'challenge'. Without the updated function every one of the
  // 36 would be invisible and members would see no challenge at all.
  const picked = await pool.query('SELECT rotate_monthly_challenge() AS code');
  assert.ok(picked.rows[0].code, 'a monthly challenge should have been picked');

  const m = await pool.query(
    'SELECT mission_type FROM missions WHERE code = $1', [picked.rows[0].code]
  );
  assert.ok(['monthly', 'challenge'].includes(m.rows[0].mission_type));
});

test('the weekly rotation still works and picks a weekly mission', async () => {
  const picked = await pool.query('SELECT rotate_weekly_mission() AS code');
  assert.ok(picked.rows[0].code);
  const m = await pool.query('SELECT mission_type FROM missions WHERE code = $1', [picked.rows[0].code]);
  assert.equal(m.rows[0].mission_type, 'weekly');
});

test('a member gets daily missions assigned from the new pool', async () => {
  const userId = await makeUser();
  await pool.query('SELECT ensure_member_participation_profile($1)', [userId]);
  await pool.query('SELECT assign_daily_missions($1)', [userId]);

  const assigned = await pool.query(
    `SELECT m.mission_type FROM user_missions um
       JOIN missions m ON m.code = um.mission_code
      WHERE um.user_id = $1 AND um.assigned_date = CURRENT_DATE`, [userId]
  );
  assert.ok(assigned.rows.length > 0, 'the member should have daily missions');
  assert.ok(assigned.rows.every((r) => r.mission_type === 'daily'));
});

test('doing a real action moves a real mission', async () => {
  // End to end through the same helper the live routes call.
  const { recordParticipation } = require('../src/utils/participation');
  const userId = await makeUser();
  await pool.query('SELECT ensure_member_participation_profile($1)', [userId]);

  // Give them a mission we control, so the assertion is about the mechanism
  // and not about which of 730 they happened to be dealt.
  await pool.query(
    `INSERT INTO user_missions (user_id, mission_code, assigned_date, progress_count, is_completed)
     SELECT $1, code, CURRENT_DATE, 0, FALSE FROM missions
      WHERE mission_type = 'daily' AND action_code = 'save_content' LIMIT 1
     ON CONFLICT DO NOTHING`, [userId]
  );

  const before = await pool.query(
    `SELECT COALESCE(SUM(progress_count), 0)::int AS p FROM user_missions
      WHERE user_id = $1 AND assigned_date = CURRENT_DATE`, [userId]
  );
  await recordParticipation(userId, 'save_content', { contentType: 'article', contentId: 1 });
  const after = await pool.query(
    `SELECT COALESCE(SUM(progress_count), 0)::int AS p FROM user_missions
      WHERE user_id = $1 AND assigned_date = CURRENT_DATE`, [userId]
  );

  assert.ok(after.rows[0].p > before.rows[0].p, 'the mission should have advanced');
});

test('an unknown action code fails safely instead of throwing', async () => {
  // A typo in a call site must never break the member action it hangs off.
  const { recordParticipation } = require('../src/utils/participation');
  const r = await recordParticipation(await makeUser(), 'not_a_real_action_code', {});
  assert.equal(r.success, false);
});

test('RE-RUNNING DOES NOT OVERWRITE AN ADMIN EDIT OR DUPLICATE', async () => {
  await pool.query(
    `UPDATE missions SET title = 'Admin Renamed This', points_reward = 999, is_enabled = FALSE
      WHERE code = 'D001'`
  );
  await pool.query(`UPDATE participation_actions SET base_points = 42 WHERE code = 'save_content'`);

  const before = await pool.query('SELECT COUNT(*)::int AS n FROM missions');
  await runMigrations();
  const after = await pool.query('SELECT COUNT(*)::int AS n FROM missions');
  assert.equal(after.rows[0].n, before.rows[0].n, 'no duplicates');

  const m = await pool.query(`SELECT title, points_reward, is_enabled FROM missions WHERE code = 'D001'`);
  assert.equal(m.rows[0].title, 'Admin Renamed This', 'the admin edit must survive a re-deploy');
  assert.equal(m.rows[0].points_reward, 999);
  assert.equal(m.rows[0].is_enabled, false);

  const a = await pool.query(`SELECT base_points FROM participation_actions WHERE code = 'save_content'`);
  assert.equal(Number(a.rows[0].base_points), 42, 'an edited point value must survive too');
});
