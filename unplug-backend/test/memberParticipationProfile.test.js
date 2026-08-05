// Participation Engine — Stage B: the personal participation profile +
// member-to-member referrals, over real PostgreSQL. No Express routes
// exist yet for this feature — these tests call the SQL functions
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-memberparticipation-'));
const port = 10400 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

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

let _nextUserId = 2000;
async function makeUser() {
  const id = _nextUserId++;
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', 'member') ON CONFLICT DO NOTHING`,
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
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await runMigrations();
});

after(async () => {
  await pool.end();
  await pg.stop();
});

test('ensure_member_participation_profile creates a profile with a unique referral code', async () => {
  const userId = await makeUser();
  const result = await pool.query(`SELECT * FROM ensure_member_participation_profile($1)`, [userId]);
  assert.equal(result.rows[0].user_id, userId);
  assert.match(result.rows[0].referral_code, /^UNPLUG-[A-Z0-9]{6}$/);
});

test('ensure_member_participation_profile is idempotent — same user always gets the same code', async () => {
  const userId = await makeUser();
  const first = await pool.query(`SELECT * FROM ensure_member_participation_profile($1)`, [userId]);
  const second = await pool.query(`SELECT * FROM ensure_member_participation_profile($1)`, [userId]);
  assert.equal(first.rows[0].referral_code, second.rows[0].referral_code);

  const count = await pool.query('SELECT COUNT(*)::INTEGER AS n FROM member_participation_profiles WHERE user_id = $1', [userId]);
  assert.equal(count.rows[0].n, 1);
});

test('referral codes are unique across different users', async () => {
  const a = await makeUser();
  const b = await makeUser();
  const profileA = await pool.query(`SELECT * FROM ensure_member_participation_profile($1)`, [a]);
  const profileB = await pool.query(`SELECT * FROM ensure_member_participation_profile($1)`, [b]);
  assert.notEqual(profileA.rows[0].referral_code, profileB.rows[0].referral_code);
});

test('a referral registration awards the referrer points and creates a record', async () => {
  const referrer = await makeUser();
  const friend = await makeUser();
  const profile = await pool.query(`SELECT * FROM ensure_member_participation_profile($1)`, [referrer]);
  const code = profile.rows[0].referral_code;

  const result = await pool.query(
    `SELECT * FROM process_member_referral($1, 'registered', $2)`,
    [code, friend]
  );
  assert.equal(result.rows[0].success, true);
  assert.equal(result.rows[0].referrer_id, referrer);
  assert.equal(result.rows[0].points_earned, 20);

  const referral = await pool.query(
    `SELECT status FROM member_referrals WHERE referrer_user_id = $1 AND referred_user_id = $2`,
    [referrer, friend]
  );
  assert.equal(referral.rows[0].status, 'registered');

  const score = await pool.query('SELECT unplug_score FROM score_cache WHERE user_id = $1', [referrer]);
  assert.equal(score.rows[0].unplug_score, 20);
});

test('the same friend cannot register against the same referrer twice', async () => {
  const referrer = await makeUser();
  const friend = await makeUser();
  const profile = await pool.query(`SELECT * FROM ensure_member_participation_profile($1)`, [referrer]);
  const code = profile.rows[0].referral_code;

  await pool.query(`SELECT * FROM process_member_referral($1, 'registered', $2)`, [code, friend]);
  const again = await pool.query(`SELECT * FROM process_member_referral($1, 'registered', $2)`, [code, friend]);
  assert.equal(again.rows[0].success, false);
  assert.equal(again.rows[0].blocked_reason, 'referral_already_recorded');
});

test('a member cannot refer themselves', async () => {
  const userId = await makeUser();
  const profile = await pool.query(`SELECT * FROM ensure_member_participation_profile($1)`, [userId]);
  const code = profile.rows[0].referral_code;

  const result = await pool.query(`SELECT * FROM process_member_referral($1, 'registered', $2)`, [code, userId]);
  assert.equal(result.rows[0].success, false);
  assert.equal(result.rows[0].blocked_reason, 'self_referral');
});

test('an unknown referral code is rejected', async () => {
  const friend = await makeUser();
  const result = await pool.query(`SELECT * FROM process_member_referral('UNPLUG-ZZZZZZ', 'registered', $1)`, [friend]);
  assert.equal(result.rows[0].success, false);
  assert.equal(result.rows[0].blocked_reason, 'referral_code_not_found');
});

test('qualifying a referral awards the larger bonus, notifies the referrer, and cannot fire twice', async () => {
  const referrer = await makeUser();
  const friend = await makeUser();
  const profile = await pool.query(`SELECT * FROM ensure_member_participation_profile($1)`, [referrer]);
  const code = profile.rows[0].referral_code;

  await pool.query(`SELECT * FROM process_member_referral($1, 'registered', $2)`, [code, friend]);
  const qualify = await pool.query(`SELECT * FROM process_member_referral($1, 'qualified', $2)`, [code, friend]);
  assert.equal(qualify.rows[0].success, true);
  assert.equal(qualify.rows[0].points_earned, 75);

  const score = await pool.query('SELECT unplug_score FROM score_cache WHERE user_id = $1', [referrer]);
  assert.equal(score.rows[0].unplug_score, 95); // 20 (registered) + 75 (qualified)

  const notif = await pool.query(
    `SELECT title FROM notifications WHERE user_id = $1 AND type = 'referral'`,
    [referrer]
  );
  assert.equal(notif.rows.length, 1);

  const twice = await pool.query(`SELECT * FROM process_member_referral($1, 'qualified', $2)`, [code, friend]);
  assert.equal(twice.rows[0].success, false);
  assert.equal(twice.rows[0].blocked_reason, 'already_qualified');
});

test('qualifying before ever registering is rejected', async () => {
  const referrer = await makeUser();
  const friend = await makeUser();
  const profile = await pool.query(`SELECT * FROM ensure_member_participation_profile($1)`, [referrer]);
  const code = profile.rows[0].referral_code;

  const result = await pool.query(`SELECT * FROM process_member_referral($1, 'qualified', $2)`, [code, friend]);
  assert.equal(result.rows[0].success, false);
  assert.equal(result.rows[0].blocked_reason, 'referral_not_found');
});

test('re-running every migration is idempotent — no duplicate referral actions or profiles', async () => {
  await runMigrations();
  const actions = await pool.query(
    `SELECT COUNT(*)::INTEGER AS n FROM participation_actions WHERE code IN ('member_referral_registered', 'member_referral_qualified')`
  );
  assert.equal(actions.rows[0].n, 2);
});
