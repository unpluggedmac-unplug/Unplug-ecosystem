// Members, Profile Social Interaction & Community System — brief item 9:
// Following Activity Feed (093_following_activity_feed.sql). Tests the
// core fan_out_following_activity() function directly, plus two
// representative call sites (award_badge, process_recognition) to prove
// the wiring actually fires end-to-end — not all six wired functions,
// since they all go through the same fan_out_following_activity() call.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-followfeed-'));
const port = 20400 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

let _nextUserId = 24000;
async function makeUser() {
  const id = _nextUserId++;
  await pool.query(`INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', 'member') ON CONFLICT DO NOTHING`, [id, `followfeed${id}@test.com`]);
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
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }
});

after(async () => {
  await pool.end();
  await pg.stop();
});

test('fan_out_following_activity notifies every follower, using the actor\'s display name', async () => {
  const actor = await pool.query(
    `INSERT INTO profiles (user_id, type, package_tier, slug, display_name, status) VALUES ($1, 'individual', 'basic', $2, 'Thandi Test', 'approved') RETURNING user_id`,
    [await makeUser(), `followfeed-actor-${Date.now()}`]
  );
  const actorId = actor.rows[0].user_id;
  const follower1 = await makeUser();
  const follower2 = await makeUser();
  const nonFollower = await makeUser();

  await pool.query('SELECT follow_member($1, $2)', [follower1, actorId]);
  await pool.query('SELECT follow_member($1, $2)', [follower2, actorId]);

  const count = await pool.query('SELECT fan_out_following_activity($1, $2, $3) AS n', [actorId, '🏅', 'did a noteworthy thing']);
  assert.equal(count.rows[0].n, 2);

  // Filtered on the exact body text injected above — the two follow_member()
  // calls just above also award the actor points, which can independently
  // cascade into its own status-change fan-out (award_points ->
  // check_and_update_status); this test only needs to prove THIS call's
  // fan-out reached the right people with the right text.
  const notifs = await pool.query(
    `SELECT user_id, title, body FROM notifications WHERE type = 'following_activity' AND body = 'Thandi Test did a noteworthy thing' ORDER BY user_id`,
    []
  );
  assert.equal(notifs.rows.length, 2);
  const forFollower1 = notifs.rows.find((r) => r.user_id === follower1);
  assert.ok(forFollower1);
  assert.equal(forFollower1.title, '🏅 Thandi Test');

  const forNonFollower = notifs.rows.find((r) => r.user_id === nonFollower);
  assert.equal(forNonFollower, undefined);
});

test('disabling notify_following_activity_enabled stops the fan-out entirely', async () => {
  const actor = await makeUser();
  const follower = await makeUser();
  // follow_member() itself awards the actor points, which can cascade into
  // a status level-up (award_points -> check_and_update_status) and its
  // own following_activity fan-out — do this BEFORE disabling, and assert
  // on the exact injected text below, so that unrelated cascade doesn't
  // make this test flaky.
  await pool.query('SELECT follow_member($1, $2)', [follower, actor]);

  await pool.query(`UPDATE settings SET value = 'false' WHERE key = 'notify_following_activity_enabled'`);
  const count = await pool.query('SELECT fan_out_following_activity($1, $2, $3) AS n', [actor, '🎯', 'did the specific thing this test checks for']);
  assert.equal(count.rows[0].n, 0);

  const notifs = await pool.query(
    `SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'following_activity' AND body LIKE '%did the specific thing this test checks for%'`,
    [follower]
  );
  assert.equal(notifs.rows.length, 0);

  await pool.query(`UPDATE settings SET value = 'true' WHERE key = 'notify_following_activity_enabled'`);
});

test('award_badge fans out to the recipient\'s followers, not just the recipient themselves', async () => {
  const recipient = await makeUser();
  const admin = await makeUser();
  const follower = await makeUser();
  await pool.query('SELECT follow_member($1, $2)', [follower, recipient]);

  await pool.query('SELECT award_badge($1, $2, $3)', [recipient, 'founding_member', admin]);

  const ownNotif = await pool.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'badge'`, [recipient]);
  assert.equal(ownNotif.rows.length, 1);

  // The follow_member() call above also awards the recipient points, which
  // can independently cascade into its own status-change fan-out — so this
  // filters specifically for the badge-earned fan-out's own body text
  // rather than asserting an exact row count for the whole (user, type).
  // The badge label lands in the BODY ("<actor> earned the ... badge"),
  // not the title (which is just "<emoji> <actor name>").
  const followerNotif = await pool.query(
    `SELECT title, body FROM notifications WHERE user_id = $1 AND type = 'following_activity' AND body LIKE '%earned the "Founding Member" badge%'`,
    [follower]
  );
  assert.equal(followerNotif.rows.length, 1);
});

test('process_recognition fans out to the recipient\'s followers', async () => {
  const from = await makeUser();
  const to = await makeUser();
  const follower = await makeUser();
  await pool.query('SELECT follow_member($1, $2)', [follower, to]);

  const result = await pool.query('SELECT * FROM process_recognition($1, $2, $3)', [from, to, 'helpful']);
  assert.equal(result.rows[0].success, true);

  // process_recognition also awards points to `to`, which can independently
  // cascade into its own status-change fan-out — filtered on the body,
  // which is where "was recognised as ..." actually lands (the title is
  // just "<emoji> <actor name>").
  const followerNotif = await pool.query(
    `SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'following_activity' AND body LIKE '%was recognised as%'`,
    [follower]
  );
  assert.equal(followerNotif.rows.length, 1);
});

test('a popular member with many followers fans out in one statement, not one row-by-row loop failure', async () => {
  const actor = await makeUser();
  const followers = await Promise.all(Array.from({ length: 25 }, () => makeUser()));
  for (const f of followers) {
    await pool.query('SELECT follow_member($1, $2)', [f, actor]);
  }
  const count = await pool.query('SELECT fan_out_following_activity($1, $2, $3) AS n', [actor, '🚀', 'did something big']);
  assert.equal(count.rows[0].n, 25);
});

test('re-running every migration is idempotent — the fan-out function and its settings key survive', async () => {
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }
  const key = await pool.query(`SELECT value FROM settings WHERE key = 'notify_following_activity_enabled'`);
  assert.equal(key.rows.length, 1);
  const fn = await pool.query(`SELECT 1 FROM pg_proc WHERE proname = 'fan_out_following_activity'`);
  assert.equal(fn.rows.length, 1);
});
