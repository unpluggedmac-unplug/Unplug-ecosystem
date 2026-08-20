// Admin-managed service pricing, tested against a REAL PostgreSQL.
//
// This is money code, and the guarantees that matter live in the database:
//
//   1. the seed prices match what the site charged before (nothing silently
//      changes price the moment this ships);
//   2. an admin price change is what gets charged afterwards;
//   3. deactivating a package stops it being sellable;
//   4. re-running the migrations does NOT revert an admin's price change —
//      db/migrate.js re-runs every migration on every deploy, so a seed written
//      as an upsert would quietly undo the admin's work on the next deploy.
//
// (4) in particular cannot be checked by reading the code, which is why this
// runs the real migration files against a real engine.
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
let packages;       // required lazily, AFTER DATABASE_URL is set
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-pkgtest-'));
const port = 6000 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

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

  process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${port}/unplug_test`;
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });

  await runMigrations();
  packages = require('../src/utils/servicePackages');
}, { timeout: 120000 });

after(async () => {
  if (pool) await pool.end();
  // Windows can still hold a handle on the data directory when Postgres
  // exits, and embedded-postgres removes that directory as part of
  // stopping. The server is already down by then, so an EBUSY here is
  // the OS being slow to let go, not a failure worth failing the file
  // for — and a teardown that goes red teaches everyone to ignore red.
  try { if (pg) await pg.stop(); } catch (e) { /* see above */ }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('seeded prices match the prices the site charged before', async () => {
  // These are the values that were hardcoded in routes/payments.js. If this
  // fails, shipping the packages table would change what customers are charged.
  assert.equal(await packages.priceFor('highlight_article', 7), 150);
  assert.equal(await packages.priceFor('highlight_article', 14), 250);
  assert.equal(await packages.priceFor('highlight_article', 21), 300);
  assert.equal(await packages.priceFor('highlight_article', 28), 450);
  assert.equal(await packages.priceFor('highlight_directory', 7), 100);
  assert.equal(await packages.priceFor('highlight_directory', 14), 150);
  assert.equal(await packages.priceFor('highlight_directory', 21), 200);
  assert.equal(await packages.priceFor('highlight_directory', 28), 250);
  assert.equal(await packages.priceFor('ad_banner', 7), 300);
  assert.equal(await packages.priceFor('ad_banner', 14), 550);
  assert.equal(await packages.priceFor('ad_banner', 28), 1000);
});

test('highlightServiceKey maps target types to package keys', () => {
  assert.equal(packages.highlightServiceKey('article'), 'highlight_article');
  assert.equal(packages.highlightServiceKey('directory'), 'highlight_directory');
});

test('an admin price change is what gets charged', async () => {
  await pool.query(
    `UPDATE service_packages SET price = 199.00
      WHERE service_key = 'highlight_article' AND duration_days = 7`
  );
  assert.equal(await packages.priceFor('highlight_article', 7), 199);
});

test('re-running migrations does NOT revert an admin price change', async () => {
  // The real risk: migrate.js re-runs every .sql on every deploy. A seed
  // written as an upsert would silently reset the admin's R199 back to R150.
  await runMigrations();
  assert.equal(
    await packages.priceFor('highlight_article', 7), 199,
    'the seed overwrote an admin-set price — it must be ON CONFLICT DO NOTHING'
  );
});

test('a deactivated package is not sellable', async () => {
  await pool.query(
    `UPDATE service_packages SET active = false
      WHERE service_key = 'highlight_article' AND duration_days = 21`
  );
  // priceFor falls back to the built-in table when there's no ACTIVE row, so
  // the caller still gets a price rather than a crash...
  assert.equal(await packages.priceFor('highlight_article', 21), 300);
  // ...but it must not be offered for sale.
  const list = await packages.packagesFor('highlight_article');
  assert.ok(!list.some((p) => p.durationDays === 21), 'inactive package was still listed');
});

test('an unknown duration is rejected rather than priced at zero', async () => {
  assert.equal(await packages.priceFor('highlight_article', 99), null);
  assert.equal(await packages.priceFor('not_a_service', 7), null);
});

test('packagesFor returns the admin-managed price and copy', async () => {
  await pool.query(
    `UPDATE service_packages SET price = 175.50, name = 'Fortnight Boost'
      WHERE service_key = 'highlight_directory' AND duration_days = 14`
  );
  const list = await packages.packagesFor('highlight_directory');
  const wk2 = list.find((p) => p.durationDays === 14);
  assert.equal(wk2.price, 175.5);
  assert.equal(wk2.name, 'Fortnight Boost');
});
