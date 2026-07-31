// The Arena's closing date, tested against a REAL PostgreSQL.
//
// Migration 066 UPDATEs live data, which is unusual and needs care: db/migrate.js
// re-runs every migration on every deploy, so an unguarded UPDATE would reset
// the date on every single deploy and silently undo whoever changed it. The
// guard is the whole point of the migration, and it cannot be verified by
// reading the SQL — it only shows up when the migrations are run twice.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-arenatest-'));
const port = 6210 + (process.pid % 300);

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

// The date as a South African reader sees it — the same formatting the
// Competitions page uses, so the test asserts on the rendered string rather
// than on a raw timestamp that could be a day out.
async function arenaClosesAsShown() {
  const r = await pool.query(`SELECT closes_at FROM competitions WHERE slug = 'the-arena'`);
  assert.equal(r.rowCount, 1, 'The Arena competition row is missing');
  return new Date(r.rows[0].closes_at).toLocaleDateString('en-ZA', {
    timeZone: 'Africa/Johannesburg', year: 'numeric', month: 'long', day: 'numeric',
  });
}

before(async () => {
  pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: false,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('unplug_test');

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: `postgres://postgres:postgres@localhost:${port}/unplug_test` });
  await runMigrations();
}, { timeout: 120000 });

after(async () => {
  if (pool) await pool.end();
  if (pg) await pg.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('The Arena closes on 31 October 2026, not the seeded placeholder', async () => {
  assert.equal(await arenaClosesAsShown(), '31 October 2026');
});

test('the date is still 31 October in South African time, not a day either side', async () => {
  // Guards the timezone choice: a UTC midnight would render as the 31st in
  // SAST but the 30th elsewhere, and the page formats in the reader's zone.
  const r = await pool.query(
    `SELECT to_char(closes_at AT TIME ZONE 'Africa/Johannesburg', 'YYYY-MM-DD') AS d
       FROM competitions WHERE slug = 'the-arena'`
  );
  assert.equal(r.rows[0].d, '2026-10-31');
});

test('re-running migrations does NOT reset a later date change', async () => {
  // The real risk. Someone moves the closing date; the next deploy re-runs
  // every migration. Without the applied_oneoffs guard, 066 would stamp
  // 31 October back over their change.
  await pool.query(
    `UPDATE competitions SET closes_at = TIMESTAMPTZ '2027-03-15 23:59:59+02'
      WHERE slug = 'the-arena'`
  );
  await runMigrations();
  assert.equal(
    await arenaClosesAsShown(), '15 March 2027',
    'migration 066 overwrote a deliberate date change — the one-off guard is not working'
  );
});

test('entering the competition is not gated on the closing date', async () => {
  // The date is presentation only. If some future change starts rejecting
  // entries past closes_at, this test is where that assumption gets caught.
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'competitions.js'), 'utf8'
  );
  const entryRoute = src.slice(src.indexOf("router.post('/competitions/:id/entries'"));
  const body = entryRoute.slice(0, entryRoute.indexOf('\nrouter.'));
  assert.ok(
    !body.includes('closes_at'),
    'the entry route now checks closes_at — moving the date can close entries'
  );
});
