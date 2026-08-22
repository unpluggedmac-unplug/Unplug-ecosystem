// Participation Engine — Stage M: Discovery Engine, over real PostgreSQL.
// Pure read-model functions — no rotation, no points — so these tests
// just seed a few rows and check the ranking logic.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-discovery-'));
const port = 14400 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

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

let _nextUserId = 10000;
async function makeUser(role = 'member') {
  const id = _nextUserId++;
  await pool.query(`INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', $3) ON CONFLICT DO NOTHING`, [id, `disc${id}@test.com`, role]);
  return id;
}

let _nextArticleId = 0;
async function makeArticle(authorId, { publishedDaysAgo = 10, views = 0 } = {}) {
  const result = await pool.query(
    `INSERT INTO articles (author_user_id, title, body, status, published_at)
     VALUES ($1, $2, 'body', 'approved', now() - ($3 || ' days')::interval) RETURNING id`,
    [authorId, `Article ${_nextArticleId++}`, String(publishedDaysAgo)]
  );
  const articleId = result.rows[0].id;
  for (let i = 0; i < views; i++) {
    await pool.query(`INSERT INTO page_views (page_path) VALUES ($1)`, [`article-${articleId}`]);
  }
  return articleId;
}

let _nextProfileId = 0;
async function makeBusinessProfile(userId) {
  const result = await pool.query(
    `INSERT INTO profiles (user_id, type, package_tier, slug, display_name, status)
     VALUES ($1, 'business', 'basic', $2, $2, 'approved') RETURNING id`,
    [userId, `disc-biz-${userId}-${_nextProfileId++}`]
  );
  return result.rows[0].id;
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

test('get_discovery_articles ranks fewer views-per-day-since-publish above more', async () => {
  const author = await makeUser();
  // Old article, decent views but had 30 days to accumulate them —
  // 1 view/day. New article, same raw view count but only 2 days old —
  // 5 views/day. The new one has been found faster, so it's the WEAKER
  // discovery candidate; the old one should rank first.
  const oldLowRate = await makeArticle(author, { publishedDaysAgo: 30, views: 30 });
  const newHighRate = await makeArticle(author, { publishedDaysAgo: 2, views: 10 });

  const result = await pool.query('SELECT * FROM get_discovery_articles(10)');
  const ids = result.rows.map((r) => r.id);
  assert.ok(ids.indexOf(oldLowRate) < ids.indexOf(newHighRate));
});

test('get_discovery_articles excludes articles published less than a day ago and pending ones', async () => {
  const author = await makeUser();
  const tooNew = await makeArticle(author, { publishedDaysAgo: 0, views: 0 });
  const pending = await pool.query(
    `INSERT INTO articles (author_user_id, title, body, status, published_at) VALUES ($1, 'Pending', 'body', 'pending', now() - interval '10 days') RETURNING id`,
    [author]
  );

  const result = await pool.query('SELECT * FROM get_discovery_articles(50)');
  const ids = result.rows.map((r) => r.id);
  assert.ok(!ids.includes(tooNew));
  assert.ok(!ids.includes(pending.rows[0].id));
});

test('get_discovery_members only includes members active in the last 14 days, ranked by fewest recognitions received', async () => {
  const inactive = await makeUser();
  const activeUnrecognised = await makeUser();
  const activeRecognised = await makeUser();
  const giver = await makeUser();
  const target = await makeUser();

  // inactive: no participation_points at all — excluded entirely.
  // activeUnrecognised: active via some other action, never recognised.
  await pool.query(`SELECT award_points($1, 'top10_vote')`, [activeUnrecognised]);
  // activeRecognised: active AND recognised, via the real production path
  // (process_recognition — p_user_id on the recognition_receive award IS
  // the receiver, per 074_recognition_achievements_missions.sql).
  await pool.query(`SELECT * FROM process_recognition($1, $2, 'helpful')`, [giver, activeRecognised]);

  const result = await pool.query('SELECT * FROM get_discovery_members(50)');
  const ids = result.rows.map((r) => r.user_id);
  assert.ok(!ids.includes(inactive));
  assert.ok(ids.includes(activeUnrecognised));
  assert.ok(ids.includes(activeRecognised));

  const unrecognisedRow = result.rows.find((r) => r.user_id === activeUnrecognised);
  const recognisedRow = result.rows.find((r) => r.user_id === activeRecognised);
  assert.equal(Number(unrecognisedRow.recognitions_received), 0);
  assert.equal(Number(recognisedRow.recognitions_received), 1);
  // Fewer recognitions ranks first.
  assert.ok(ids.indexOf(activeUnrecognised) < ids.indexOf(activeRecognised));
});

test('get_discovery_businesses only includes approved businesses at rank 1 or 2 on the status ladder', async () => {
  const lowOwner = await makeUser();
  const highOwner = await makeUser();
  const lowProfile = await makeBusinessProfile(lowOwner);
  const highProfile = await makeBusinessProfile(highOwner);

  await pool.query('SELECT check_and_update_business_status($1)', [lowProfile]); // -> new_listing (rank 1)

  // Push highProfile to trusted_business (rank 3) — needs 10 reviews,
  // avg 4.0, 3 gallery, 60 days.
  for (let i = 0; i < 10; i++) {
    const reviewer = await makeUser();
    await pool.query(
      `INSERT INTO profile_reviews (profile_id, user_id, rating, status, reviewed_at) VALUES ($1, $2, 5, 'approved', now())`,
      [highProfile, reviewer]
    );
  }
  for (let i = 0; i < 3; i++) {
    await pool.query(`INSERT INTO gallery_images (owner_type, owner_id, image_url, status) VALUES ('profile', $1, 'x.jpg', 'approved')`, [highProfile]);
  }
  await pool.query(`UPDATE profiles SET created_at = now() - INTERVAL '90 days' WHERE id = $1`, [highProfile]);
  await pool.query('SELECT check_and_update_business_status($1)', [highProfile]);

  const result = await pool.query('SELECT * FROM get_discovery_businesses(50)');
  const ids = result.rows.map((r) => r.id);
  assert.ok(ids.includes(lowProfile));
  assert.ok(!ids.includes(highProfile));
});
