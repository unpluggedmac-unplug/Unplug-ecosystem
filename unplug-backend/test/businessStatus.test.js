// Participation Engine — Stage I: Business status ladder, over real
// PostgreSQL. Exercises the SQL functions directly, same approach as
// weeklyMissions.test.js.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-bizstatus-'));
const port = 13200 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

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

let _nextUserId = 7000;
async function makeUser() {
  const id = _nextUserId++;
  await pool.query(`INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', 'member') ON CONFLICT DO NOTHING`, [id, `biz${id}@test.com`]);
  return id;
}

let _nextProfileId = 0;
async function makeProfile(userId, type = 'business') {
  const result = await pool.query(
    `INSERT INTO profiles (user_id, type, package_tier, slug, display_name, status)
     VALUES ($1, $2, 'basic', $3, $3, 'approved') RETURNING id`,
    [userId, type, `biz-profile-${userId}-${_nextProfileId++}`]
  );
  return result.rows[0].id;
}

async function addApprovedReview(profileId, reviewerUserId, rating) {
  await pool.query(
    `INSERT INTO profile_reviews (profile_id, user_id, rating, status, reviewed_at) VALUES ($1, $2, $3, 'approved', now())`,
    [profileId, reviewerUserId, rating]
  );
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

test('a fresh approved business profile is promoted to new_listing on first check', async () => {
  const owner = await makeUser();
  const profileId = await makeProfile(owner);

  const result = await pool.query('SELECT check_and_update_business_status($1) AS r', [profileId]);
  assert.equal(result.rows[0].r, 'promoted_to_new_listing');

  const rank = await pool.query('SELECT get_business_status_rank($1) AS rank', [profileId]);
  assert.equal(rank.rows[0].rank, 1);
});

test('an individual (non-business) profile is a no-op, not an error', async () => {
  const owner = await makeUser();
  const profileId = await makeProfile(owner, 'individual');

  const result = await pool.query('SELECT check_and_update_business_status($1) AS r', [profileId]);
  assert.equal(result.rows[0].r, 'not_a_business');
});

test('running the check again with nothing changed does not re-promote or duplicate history', async () => {
  const owner = await makeUser();
  const profileId = await makeProfile(owner);
  await pool.query('SELECT check_and_update_business_status($1)', [profileId]);

  const again = await pool.query('SELECT check_and_update_business_status($1) AS r', [profileId]);
  assert.equal(again.rows[0].r, 'no_new_status');

  const rows = await pool.query('SELECT COUNT(*)::INTEGER AS n FROM business_status_history WHERE profile_id = $1', [profileId]);
  assert.equal(rows.rows[0].n, 1);
});

test('enough approved reviews at a high enough rating promotes past new_listing to rising_business', async () => {
  const owner = await makeUser();
  const profileId = await makeProfile(owner);
  await pool.query('SELECT check_and_update_business_status($1)', [profileId]); // -> new_listing

  // rising_business needs 3 reviews, avg >= 3.5 — min_days_listed(14) is not
  // met by a profile created moments ago, so this deliberately stays below
  // rising_business's tenure gate to prove the gate is enforced, not just
  // the review count.
  for (let i = 0; i < 3; i++) {
    const reviewer = await makeUser();
    await addApprovedReview(profileId, reviewer, 5);
  }
  const stillGated = await pool.query('SELECT check_and_update_business_status($1) AS r', [profileId]);
  assert.equal(stillGated.rows[0].r, 'no_new_status');

  // Backdate the listing so min_days_listed(14) is satisfied too.
  await pool.query(`UPDATE profiles SET created_at = now() - INTERVAL '30 days' WHERE id = $1`, [profileId]);
  const promoted = await pool.query('SELECT check_and_update_business_status($1) AS r', [profileId]);
  assert.equal(promoted.rows[0].r, 'promoted_to_rising_business');
});

test('an unapproved (pending) review does not count toward the average or the count', async () => {
  const owner = await makeUser();
  const profileId = await makeProfile(owner);
  const reviewer = await makeUser();
  await pool.query(
    `INSERT INTO profile_reviews (profile_id, user_id, rating, status) VALUES ($1, $2, 1, 'pending')`,
    [profileId, reviewer]
  );
  const metrics = await pool.query('SELECT * FROM get_business_metrics($1)', [profileId]);
  assert.equal(metrics.rows[0].reviews_count, 0);
  assert.equal(Number(metrics.rows[0].avg_rating), 0);
});

test('an admin can manually grant business_hall_of_fame, which is never auto-promoted into', async () => {
  const owner = await makeUser();
  const profileId = await makeProfile(owner);
  await pool.query('SELECT check_and_update_business_status($1)', [profileId]);

  // Reviews and tenure alone (no approved gallery images) cap this at
  // rising_business — trusted_business and above all require at least 3
  // approved gallery images, which this profile deliberately never gets.
  // Even so, hall of fame requires admin approval and must not be
  // auto-selected no matter how far past every OTHER threshold this goes.
  for (let i = 0; i < 60; i++) {
    const reviewer = await makeUser();
    await addApprovedReview(profileId, reviewer, 5);
  }
  await pool.query(`UPDATE profiles SET created_at = now() - INTERVAL '2000 days' WHERE id = $1`, [profileId]);
  const autoResult = await pool.query('SELECT check_and_update_business_status($1) AS r', [profileId]);
  assert.notEqual(autoResult.rows[0].r, 'promoted_to_business_hall_of_fame');

  const rankBefore = await pool.query('SELECT get_business_status_rank($1) AS rank', [profileId]);
  assert.equal(rankBefore.rows[0].rank, 2); // rising_business — the highest reachable without gallery images

  // Now the admin grants hall of fame directly.
  await pool.query('SELECT check_and_update_business_status($1)', [profileId]); // no-op, re-confirms cap
  await pool.query(
    `UPDATE business_status_history SET is_active_status = FALSE WHERE profile_id = $1 AND is_active_status = TRUE`,
    [profileId]
  );
  await pool.query(
    `INSERT INTO business_status_history (profile_id, status_code, previous_status, is_active_status)
     VALUES ($1, 'business_hall_of_fame', 'rising_business', TRUE)`,
    [profileId]
  );
  const rankAfter = await pool.query('SELECT get_business_status_rank($1) AS rank', [profileId]);
  assert.equal(rankAfter.rows[0].rank, 5);
});

test('re-running every migration is idempotent — the five business status levels stay stable', async () => {
  await runMigrations();
  const levels = await pool.query('SELECT COUNT(*)::INTEGER AS n FROM business_status_levels');
  assert.equal(levels.rows[0].n, 5);
});
