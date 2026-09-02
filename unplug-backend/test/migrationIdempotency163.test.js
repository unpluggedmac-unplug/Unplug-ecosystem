// Migrations re-run on EVERY deploy — npm start is `npm run migrate && node
// src/app.js` — so a migration that is not safe to apply twice is not a failed
// migration, it is an outage. This runs the whole set three times over and then
// checks that 163 actually did what it claims.
//
// The one that has to be watched is the CHECK. ADD CONSTRAINT has no
// IF NOT EXISTS, so it is dropped and re-added each deploy, and Postgres
// re-validates it against every row in the table each time. It passes only
// because end_date is NULL on every pre-existing row. This test also puts a
// real multi-day event in the table BEFORE the final pass, so the constraint is
// re-validated against live-shaped data rather than an empty table.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const EmbeddedPostgres = require('embedded-postgres').default;
const { stopPostgres } = require('./helpers/stopPostgres');
const { ensureStopWords } = require('./helpers/textSearch');

let pg;
let pool;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-mig163-'));
const port = 49200 + (process.pid % 300);

const migrationDir = path.join(__dirname, '..', 'db', 'migrations');
const files = () => fs.readdirSync(migrationDir).filter((f) => f.endsWith('.sql')).sort();

async function runAll() {
  for (const f of files()) {
    try {
      await pool.query(fs.readFileSync(path.join(migrationDir, f), 'utf8'));
    } catch (err) {
      throw new Error(`migration ${f} failed: ${err.message}`);
    }
  }
}

before(async () => {
  ensureStopWords();
  pg = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'postgres', password: 'postgres', port,
    persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('unplug_test');
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: `postgres://postgres:postgres@localhost:${port}/unplug_test` });
});

after(async () => {
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
});

test('THE WHOLE MIGRATION SET SURVIVES BEING RUN THREE TIMES', async () => {
  await runAll();                 // a fresh database
  await runAll();                 // the next deploy
  await pool.query(`INSERT INTO users (id, email, full_name, password_hash, role)
                    VALUES (963001, 'mig@ev.test', 'Mig', 'x', 'member')`);
  await pool.query(
    `INSERT INTO events (organizer_user_id, name, event_date, end_date, status)
     VALUES (963001, 'Three-day festival', '2027-03-05', '2027-03-07', 'approved')`);
  await runAll();                 // and a deploy with real multi-day data present
});

test('163 left the column, the constraint and the index in place', async () => {
  const col = await pool.query(
    `SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'events' AND column_name = 'end_date'`);
  assert.equal(col.rowCount, 1, 'end_date should exist');
  assert.equal(col.rows[0].data_type, 'date');
  assert.equal(col.rows[0].is_nullable, 'YES', 'NULL is what means "one day"');

  const con = await pool.query(
    `SELECT COUNT(*)::int AS n FROM pg_constraint WHERE conname = 'events_end_date_check'`);
  assert.equal(con.rows[0].n, 1, 'exactly one copy of the check, not three');

  const idx = await pool.query(
    `SELECT COUNT(*)::int AS n FROM pg_indexes
      WHERE tablename = 'events' AND indexname = 'idx_events_runs_until'`);
  assert.equal(idx.rows[0].n, 1);
});

test('the multi-day event inserted mid-run is still intact afterwards', async () => {
  // Proves the re-validation on the last pass did not reject or drop it.
  const r = await pool.query(
    `SELECT to_char(end_date, 'YYYY-MM-DD') AS e FROM events WHERE name = 'Three-day festival'`);
  assert.equal(r.rows[0].e, '2027-03-07');
});

test('every migration file is numbered uniquely', async () => {
  // Two files with the same number means one silently wins depending on sort.
  const nums = files().map((f) => f.slice(0, 3));
  const dupes = nums.filter((n, i) => nums.indexOf(n) !== i);
  assert.deepEqual([...new Set(dupes)], [], 'duplicate migration numbers');
});
