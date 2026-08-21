// Admins stay off the member leaderboard, against a REAL PostgreSQL.
//
// The owner's own account was sitting at #1, above the members the board
// exists to celebrate. Two things have to hold, and the second is the one that
// is easy to get wrong:
//
//   1. no admin appears on any board — leaderboard, biggest movers, or the
//      homepage modules, all of which read the same rankings table;
//   2. the ranks RENUMBER. Filtering an admin out at read time would leave the
//      gap behind and the board would start at "#2", which looks broken. The
//      exclusion happens before ROW_NUMBER() precisely so that cannot happen.
//
// Also checked: re-running the migrations does not undo it, and does not
// rebuild every board on every deploy when there is nothing to fix.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-lbadmin-'));
const port = 33600 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

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

let _nextUserId = 881000;
async function makeUser(role, points) {
  const id = _nextUserId++;
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', $3)`,
    [id, `lb${id}@test.com`, role]);
  // score_cache is what the lifetime boards rank from.
  await pool.query(
    `INSERT INTO score_cache (user_id, unplug_score, recognition_score, contribution_score)
     VALUES ($1, $2, $2, $2)
     ON CONFLICT (user_id) DO UPDATE SET unplug_score = EXCLUDED.unplug_score`,
    [id, points]);
  return id;
}

async function board(type = 'overall') {
  const r = await pool.query(
    `SELECT * FROM get_leaderboard($1, 50, 0, 'lifetime', 'all-time')`, [type]);
  return r.rows;
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
  if (pool) await pool.end();
  // Windows can still hold a handle on the data directory when Postgres
  // exits, and embedded-postgres removes that directory as part of
  // stopping. The server is already down by then, so an EBUSY here is
  // the OS being slow to let go, not a failure worth failing the file
  // for — and a teardown that goes red teaches everyone to ignore red.
  try { if (pg) await pg.stop(); } catch (e) { /* see above */ }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* Windows holds the dir briefly */ }
});

// ---------------------------------------------------------------------------

test('AN ADMIN WITH THE TOP SCORE DOES NOT APPEAR ON THE BOARD', async () => {
  // Exactly the reported situation: the admin outscores every member.
  const adminId = await makeUser('admin', 16);
  const m1 = await makeUser('member', 15);
  const m2 = await makeUser('member', 5);

  await pool.query('SELECT recalculate_ranking($1)', ['overall']);
  const rows = await board('overall');

  assert.ok(!rows.some((r) => r.user_id === adminId),
    'the admin must not be on the member leaderboard');
  assert.ok(rows.some((r) => r.user_id === m1), 'members are still ranked');
  assert.ok(rows.some((r) => r.user_id === m2));
});

test('THE BOARD STARTS AT #1, NOT #2 — the ranks renumber', async () => {
  // The reason this is filtered before ROW_NUMBER() rather than after the
  // fact. A board whose top row says "#2" reads as broken.
  const rows = await board('overall');
  assert.ok(rows.length > 0);
  assert.equal(rows[0].rank_position, 1, 'the top member is #1');

  const positions = rows.map((r) => r.rank_position);
  const expected = positions.map((_, i) => i + 1);
  assert.deepEqual(positions, expected, 'no gaps anywhere in the board');
});

test('the highest-scoring MEMBER takes the top place the admin vacated', async () => {
  const rows = await board('overall');
  assert.equal(rows[0].score_value, 15,
    'the 15-point member is now first, not the 16-point admin');
});

test('every board type excludes admins, not just the overall one', async () => {
  for (const type of ['overall', 'recognition', 'contribution']) {
    await pool.query('SELECT recalculate_ranking($1)', [type]);
    const rows = await board(type);
    const roles = await pool.query(
      `SELECT u.role FROM users u WHERE u.id = ANY($1)`,
      [rows.map((r) => r.user_id)]);
    assert.ok(!roles.rows.some((r) => r.role === 'admin'),
      `an admin reached the ${type} board`);
  }
});

test('the weekly and monthly boards exclude admins too', async () => {
  // A different function builds these, from participation_points rather than
  // score_cache — it had no users join at all before this change.
  const adminId = await makeUser('admin', 0);
  const memberId = await makeUser('member', 0);
  const action = await pool.query('SELECT code FROM participation_actions LIMIT 1');
  if (action.rowCount === 0) return; // no seeded actions; nothing to rank

  for (const uid of [adminId, memberId]) {
    await pool.query(
      `INSERT INTO participation_points (user_id, action_code, total_points, earned_at, is_reversed)
       VALUES ($1, $2, 50, now(), FALSE)`, [uid, action.rows[0].code]);
  }

  for (const period of ['weekly', 'monthly']) {
    await pool.query('SELECT recalculate_period_ranking($1, $2)', ['overall', period]);
    const rows = await pool.query(
      `SELECT r.user_id FROM rankings r WHERE r.period_type = $1`, [period]);
    assert.ok(!rows.rows.some((r) => r.user_id === adminId),
      `the admin reached the ${period} board`);
    assert.ok(rows.rows.some((r) => r.user_id === memberId),
      `the member is missing from the ${period} board`);
  }
});

test('members other than admins are untouched — investors, advertisers, consultants still rank', async () => {
  // The instruction was about admins. Everyone else is a real person who may
  // legitimately take part, so nothing else was quietly excluded.
  const ids = {};
  for (const role of ['investor', 'advertiser', 'consultant']) {
    ids[role] = await makeUser(role, 40);
  }
  await pool.query('SELECT recalculate_ranking($1)', ['overall']);
  const rows = await board('overall');
  for (const [role, id] of Object.entries(ids)) {
    assert.ok(rows.some((r) => r.user_id === id), `${role} should still be ranked`);
  }
});

test('an admin is off the biggest-movers list as well', async () => {
  // Movers reads the same rankings table, so removing the row covers it —
  // asserted rather than assumed.
  const movers = await pool.query('SELECT * FROM get_biggest_movers(50)');
  if (movers.rowCount === 0) return;
  const roles = await pool.query(
    `SELECT u.role FROM users u WHERE u.id = ANY($1)`,
    [movers.rows.map((m) => m.user_id)]);
  assert.ok(!roles.rows.some((r) => r.role === 'admin'));
});

test('RE-RUNNING EVERY MIGRATION KEEPS ADMINS OFF AND DOES NOT UNDO THE FILTER', async () => {
  // migrate.js re-runs every .sql on every deploy. A later migration
  // redefining these functions from an older copy is exactly how this
  // codebase lost award_badge behaviour three times.
  const adminId = await makeUser('admin', 999);
  await runMigrations();
  await pool.query('SELECT recalculate_ranking($1)', ['overall']);

  const rows = await board('overall');
  assert.ok(!rows.some((r) => r.user_id === adminId),
    'a redeploy let the admin back onto the board');
  assert.equal(rows[0].rank_position, 1, 'and the board still starts at #1');
});

test('the cleanup only runs when there is actually an admin on the board', async () => {
  // A bare recalculate_all_rankings() in the migration would rebuild every
  // board on every deploy for nothing. Once clean, re-running must be a no-op,
  // which is observable as calculated_at not moving.
  await pool.query(`DELETE FROM rankings r USING users u
                     WHERE u.id = r.user_id AND u.role = 'admin'`);
  const before = await pool.query(
    `SELECT MAX(calculated_at) AS t FROM rankings`);
  await runMigrations();
  const after = await pool.query(
    `SELECT MAX(calculated_at) AS t FROM rankings`);
  assert.deepEqual(after.rows[0].t, before.rows[0].t,
    'the migration recomputed the boards when nothing needed fixing');
});
