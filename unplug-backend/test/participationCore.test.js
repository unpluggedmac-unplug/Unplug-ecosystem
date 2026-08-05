// Participation Engine — Stage A: rule engine + point ledger + status
// promotion, over real PostgreSQL. No Express routes exist yet for this
// feature (that's a later stage) — these tests exercise the SQL functions
// directly, the same functions the routes will call via pool.query(...)
// once they exist.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-participation-'));
const port = 10000 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

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

let _nextUserId = 1000;
async function makeUser() {
  const id = _nextUserId++;
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', 'member') ON CONFLICT DO NOTHING`,
    [id, `p${id}@test.com`]
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

  // A simple test action: unlimited unique-per-object action worth 10 points,
  // counts toward active-month qualification and streak.
  await pool.query(`
    INSERT INTO participation_actions (code, label, category_code, base_points, daily_limit, unique_per_object, counts_for_active_month, counts_as_meaningful, counts_as_contribution, counts_for_streak)
    VALUES ('test_action', 'Test Action', 'contribution', 10, 3, TRUE, TRUE, TRUE, TRUE, TRUE)
    ON CONFLICT (code) DO NOTHING
  `);
  await pool.query(`
    INSERT INTO participation_actions (code, label, category_code, base_points, unique_per_object)
    VALUES ('test_action_no_limit', 'Test Action No Limit', 'contribution', 5, FALSE)
    ON CONFLICT (code) DO NOTHING
  `);
});

after(async () => {
  await pool.end();
  await pg.stop();
});

test('award_points writes a ledger row and updates the score cache', async () => {
  const userId = await makeUser();
  const result = await pool.query(
    `SELECT * FROM award_points($1, 'test_action', 'article', 1)`,
    [userId]
  );
  assert.equal(result.rows[0].success, true);
  assert.equal(result.rows[0].points_earned, 10);

  const cache = await pool.query('SELECT unplug_score, contribution_score, total_actions FROM score_cache WHERE user_id = $1', [userId]);
  assert.equal(cache.rows[0].unplug_score, 10);
  assert.equal(cache.rows[0].contribution_score, 10);
  assert.equal(cache.rows[0].total_actions, 1);
});

test('unique_per_object blocks a second award for the same content item', async () => {
  const userId = await makeUser();
  await pool.query(`SELECT * FROM award_points($1, 'test_action', 'article', 42)`, [userId]);
  const second = await pool.query(`SELECT * FROM award_points($1, 'test_action', 'article', 42)`, [userId]);
  assert.equal(second.rows[0].success, false);
  assert.equal(second.rows[0].blocked_reason, 'already_earned_for_object');

  const points = await pool.query('SELECT unplug_score FROM score_cache WHERE user_id = $1', [userId]);
  assert.equal(points.rows[0].unplug_score, 10); // only the first award counted
});

test('a daily_limit stops further awards once reached', async () => {
  const userId = await makeUser();
  // test_action has daily_limit = 3; use distinct content ids so uniqueness isn't what blocks it
  await pool.query(`SELECT * FROM award_points($1, 'test_action', 'article', 1)`, [userId]);
  await pool.query(`SELECT * FROM award_points($1, 'test_action', 'article', 2)`, [userId]);
  await pool.query(`SELECT * FROM award_points($1, 'test_action', 'article', 3)`, [userId]);
  const fourth = await pool.query(`SELECT * FROM award_points($1, 'test_action', 'article', 4)`, [userId]);
  assert.equal(fourth.rows[0].success, false);
  assert.equal(fourth.rows[0].blocked_reason, 'daily_limit_reached');
});

test('an unknown or disabled action is rejected', async () => {
  const userId = await makeUser();
  const result = await pool.query(`SELECT * FROM award_points($1, 'does_not_exist')`, [userId]);
  assert.equal(result.rows[0].success, false);
  assert.equal(result.rows[0].blocked_reason, 'action_not_found_or_disabled');
});

test('a low trust score blocks an action requiring a higher one', async () => {
  const userId = await makeUser();
  await pool.query(`
    INSERT INTO participation_actions (code, label, category_code, base_points, min_trust_score, unique_per_object)
    VALUES ('trust_gated', 'Trust Gated', 'contribution', 10, 90, FALSE)
    ON CONFLICT (code) DO NOTHING
  `);
  await pool.query(`INSERT INTO trust_scores (user_id, score) VALUES ($1, 50) ON CONFLICT (user_id) DO UPDATE SET score = 50`, [userId]);

  const result = await pool.query(`SELECT * FROM award_points($1, 'trust_gated')`, [userId]);
  assert.equal(result.rows[0].success, false);
  assert.equal(result.rows[0].blocked_reason, 'trust_score_insufficient');
});

test('reaching a status threshold promotes the member and queues a notification', async () => {
  const userId = await makeUser();
  // trailblazer requires min_score 500, min_days_since_join 30, min_active_months 1.
  // Force the qualifying preconditions directly, then a single award that
  // crosses the score line — check_and_update_status() picks the HIGHEST
  // tier the member now qualifies for (not the next one up), so this
  // should promote straight to trailblazer, skipping explorer entirely.
  await pool.query(`UPDATE users SET created_at = now() - INTERVAL '40 days' WHERE id = $1`, [userId]);
  await pool.query(`
    INSERT INTO active_months (user_id, year, month, active_days, meaningful_actions, qualifying_contributions, is_qualified, qualified_at)
    VALUES ($1, EXTRACT(YEAR FROM now())::INTEGER, EXTRACT(MONTH FROM now())::INTEGER, 5, 10, 2, TRUE, now())
  `, [userId]);
  await pool.query(`
    INSERT INTO participation_actions (code, label, category_code, base_points, unique_per_object)
    VALUES ('test_big_grant', 'Test Big Grant', 'contribution', 500, TRUE)
    ON CONFLICT (code) DO NOTHING
  `);

  const award = await pool.query(`SELECT * FROM award_points($1, 'test_big_grant', 'article', 999)`, [userId]);
  assert.equal(award.rows[0].success, true);

  const status = await pool.query(
    `SELECT status_code FROM member_status_history WHERE user_id = $1 AND is_active_status = TRUE`,
    [userId]
  );
  assert.equal(status.rows[0].status_code, 'trailblazer');

  const notif = await pool.query(
    `SELECT title FROM notifications WHERE user_id = $1 AND type = 'status_change'`,
    [userId]
  );
  assert.equal(notif.rows.length, 1);
  assert.match(notif.rows[0].title, /Trailblazer/);
});

test('reverse_points undoes a transaction and recalculates the score cache', async () => {
  const userId = await makeUser();
  const award = await pool.query(`SELECT * FROM award_points($1, 'test_action_no_limit')`, [userId]);
  const txId = award.rows[0].tx_id;

  const before1 = await pool.query('SELECT unplug_score FROM score_cache WHERE user_id = $1', [userId]);
  assert.equal(before1.rows[0].unplug_score, 5);

  const adminId = await makeUser();
  const ok = await pool.query(`SELECT reverse_points($1, $2, 'test correction') AS ok`, [txId, adminId]);
  assert.equal(ok.rows[0].ok, true);

  const after1 = await pool.query('SELECT unplug_score FROM score_cache WHERE user_id = $1', [userId]);
  assert.equal(after1.rows[0].unplug_score, 0);

  const tx = await pool.query('SELECT is_reversed FROM participation_points WHERE id = $1', [txId]);
  assert.equal(tx.rows[0].is_reversed, true);

  // Reversing the same transaction twice is a no-op, not an error.
  const again = await pool.query(`SELECT reverse_points($1, $2, 'double reverse') AS ok`, [txId, adminId]);
  assert.equal(again.rows[0].ok, false);
});

test('admin_award_points grants an arbitrary amount and logs a moderation action', async () => {
  const userId = await makeUser();
  const adminId = await makeUser();
  const result = await pool.query(
    `SELECT * FROM admin_award_points($1, $2, 250, 'goodwill grant')`,
    [userId, adminId]
  );
  assert.equal(result.rows[0].success, true);

  const cache = await pool.query('SELECT unplug_score FROM score_cache WHERE user_id = $1', [userId]);
  assert.equal(cache.rows[0].unplug_score, 250);

  const mod = await pool.query(
    `SELECT action_type, points_affected FROM moderation_actions WHERE target_user_id = $1 AND admin_user_id = $2`,
    [userId, adminId]
  );
  assert.equal(mod.rows[0].action_type, 'award_points');
  assert.equal(mod.rows[0].points_affected, 250);
});

test('re-running every migration is idempotent and does not duplicate seed data', async () => {
  await runMigrations();
  const statuses = await pool.query('SELECT COUNT(*)::INTEGER AS n FROM member_status_levels');
  assert.equal(statuses.rows[0].n, 6);
  const categories = await pool.query('SELECT COUNT(*)::INTEGER AS n FROM action_categories');
  assert.equal(categories.rows[0].n, 6);
});
