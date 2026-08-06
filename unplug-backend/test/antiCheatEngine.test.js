// Participation Engine — Stage O: Anti-Cheat Engine, over real
// PostgreSQL. Exercises the SQL functions directly, same approach as
// every other stage's tests in this suite.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-anticheat-'));
const port = 14800 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

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

let _nextUserId = 11000;
async function makeUser() {
  const id = _nextUserId++;
  await pool.query(`INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', 'member') ON CONFLICT DO NOTHING`, [id, `cheat${id}@test.com`]);
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

test('a member with normal activity is never flagged', async () => {
  const userId = await makeUser();
  await pool.query(`SELECT award_points($1, 'achievement_earned')`, [userId]);
  const trust = await pool.query('SELECT * FROM trust_scores WHERE user_id = $1', [userId]);
  assert.equal(trust.rows.length, 0); // no row at all — never flagged, never touched
});

test('check_velocity_abuse flags a user who exceeds 20 point-earning actions in 5 minutes', async () => {
  const userId = await makeUser();
  for (let i = 0; i < 21; i++) {
    await pool.query(`SELECT award_points($1, 'achievement_earned')`, [userId]);
  }
  const trust = await pool.query('SELECT score, flags FROM trust_scores WHERE user_id = $1', [userId]);
  assert.equal(trust.rows.length, 1);
  assert.equal(Number(trust.rows[0].score), 85); // 100 - 15
  assert.equal(trust.rows[0].flags, 1);

  const log = await pool.query(`SELECT * FROM moderation_actions WHERE target_user_id = $1 AND action_type = 'auto_flag_velocity'`, [userId]);
  assert.equal(log.rows.length, 1);
  assert.equal(log.rows[0].admin_user_id, null); // automatic, not admin-initiated
});

test('check_reciprocal_recognition_abuse flags BOTH members of a farming pair, not just one', async () => {
  const a = await makeUser();
  const b = await makeUser();
  const types = ['inspiring', 'innovative', 'creative', 'entrepreneurial', 'community_builder', 'rising_talent', 'proudly_sa', 'local_hero'];
  for (const t of types) {
    await pool.query(`SELECT * FROM process_recognition($1, $2, $3)`, [a, b, t]);
  }
  // 8 recognitions a->b hits the threshold on its own, and process_recognition
  // checks (from, to) which is exactly this pair — reciprocity in the literal
  // "both directions" sense isn't required to trigger; a one-sided burst of
  // 8 toward the same person within 7 days is itself the farming signal.
  const trustA = await pool.query('SELECT score, flags FROM trust_scores WHERE user_id = $1', [a]);
  const trustB = await pool.query('SELECT score, flags FROM trust_scores WHERE user_id = $1', [b]);
  assert.equal(Number(trustA.rows[0].score), 75); // 100 - 25
  assert.equal(Number(trustB.rows[0].score), 75);
});

test('a trust score below an action\'s min_trust_score blocks that action', async () => {
  const userId = await makeUser();
  // Force trust below the 50 floor set on recognition_give/receive/top10_vote.
  await pool.query(
    `INSERT INTO trust_scores (user_id, score, flags) VALUES ($1, 30, 3)`,
    [userId]
  );
  const result = await pool.query(`SELECT * FROM award_points($1, 'top10_vote')`, [userId]);
  assert.equal(result.rows[0].success, false);
  assert.equal(result.rows[0].blocked_reason, 'trust_score_insufficient');

  // An action with no min_trust_score floor still works — the gate is
  // per-action, not a global ban.
  const other = await pool.query(`SELECT * FROM award_points($1, 'achievement_earned')`, [userId]);
  assert.equal(other.rows[0].success, true);
});

test('re-running every migration is idempotent — min_trust_score stays applied, not doubled up', async () => {
  await runMigrations();
  const rows = await pool.query(`SELECT min_trust_score FROM participation_actions WHERE code = 'top10_vote'`);
  assert.equal(Number(rows.rows[0].min_trust_score), 50);
});
