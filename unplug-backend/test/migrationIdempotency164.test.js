// Migration 164 runs on EVERY deploy, and it allocates invoice numbers.
//
// That combination is the dangerous one. `npm start` is `npm run migrate &&
// node src/app.js`, so 164 executes again on every single deploy. If its
// backfill matched rows a second time it would issue a SECOND invoice for
// orders that already have one — duplicate numbers for the same money, growing
// by one set per deploy, discovered by an accountant rather than by us.
//
// So this runs the whole migration set three times over and asserts that the
// second and third passes change NOTHING: same row count, same numbers, and no
// sequence values burned.

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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-mig164-'));
const port = 52400 + (process.pid % 300);

const migrationsDir = path.join(__dirname, '..', 'db', 'migrations');
const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

async function runAllMigrations() {
  for (const f of files) {
    await pool.query(fs.readFileSync(path.join(migrationsDir, f), 'utf8'));
  }
}

async function snapshot() {
  const invoices = await pool.query(
    `SELECT invoice_number, order_id, reference, total
       FROM invoices ORDER BY invoice_number`);
  const seq = await pool.query(`SELECT last_value, is_called FROM invoice_number_seq`);
  const settings = await pool.query(
    `SELECT key, value FROM settings WHERE key LIKE 'vat%' ORDER BY key`);
  return {
    invoices: invoices.rows,
    seq: `${seq.rows[0].last_value}/${seq.rows[0].is_called}`,
    settings: settings.rows,
  };
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
  pool = new Pool({
    connectionString: `postgres://postgres:postgres@localhost:${port}/unplug_test`,
  });
});

after(async () => {
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
});

test('MIGRATION 164 IS SAFE TO RUN AGAIN, AND AGAIN', async () => {
  // Pass one: build the schema, then give it confirmed orders to backfill.
  await runAllMigrations();

  await pool.query(
    `INSERT INTO users (id, email, full_name, password_hash, role)
     VALUES (991001,'mig@inv.test','Mig','x','member')`);
  for (const [ref, when] of [
    ['UNP-MIG-1', '2025-01-15'],
    ['UNP-MIG-2', '2025-06-30'],
    ['UNP-MIG-3', '2026-02-02'],
  ]) {
    await pool.query(
      `INSERT INTO orders (user_id, reference, method, status, subtotal, total,
                           terms_version, terms_accepted_at, info_confirmed_at, confirmed_at)
       VALUES (991001,$1,'eft','confirmed', 100, 100,'v1', now(), now(), $2)`,
      [ref, when]);
  }
  // An unpaid one, which must never be backfilled.
  await pool.query(
    `INSERT INTO orders (user_id, reference, method, status, subtotal, total,
                         terms_version, terms_accepted_at, info_confirmed_at)
     VALUES (991001,'UNP-MIG-UNPAID','eft','pending', 100, 100,'v1', now(), now())`);

  // Pass two: this is the one that does the backfill (the orders did not exist
  // when 164 first ran).
  await runAllMigrations();
  const afterBackfill = await snapshot();

  assert.equal(afterBackfill.invoices.length, 3,
    'exactly the three CONFIRMED orders should have been invoiced');
  assert.ok(!afterBackfill.invoices.some((i) => i.reference === 'UNP-MIG-UNPAID'),
    'an unpaid order must never get an invoice');

  // Passes three and four: nothing whatsoever may change.
  await runAllMigrations();
  const third = await snapshot();
  await runAllMigrations();
  const fourth = await snapshot();

  assert.deepEqual(third, afterBackfill, 'the third pass changed something');
  assert.deepEqual(fourth, afterBackfill, 'the fourth pass changed something');
});

test('the backfill numbers in payment order, oldest first', async () => {
  const r = await pool.query(
    `SELECT i.invoice_number, i.reference
       FROM invoices i ORDER BY i.invoice_number`);
  assert.deepEqual(r.rows.map((x) => x.reference),
    ['UNP-MIG-1', 'UNP-MIG-2', 'UNP-MIG-3'],
    'numbers should follow the order the money arrived in');
});

test('each invoice carries the year it was actually paid', async () => {
  const r = await pool.query(`SELECT invoice_number, reference FROM invoices`);
  const byRef = Object.fromEntries(r.rows.map((x) => [x.reference, x.invoice_number]));
  assert.ok(byRef['UNP-MIG-1'].startsWith('INV-2025-'), byRef['UNP-MIG-1']);
  assert.ok(byRef['UNP-MIG-2'].startsWith('INV-2025-'), byRef['UNP-MIG-2']);
  assert.ok(byRef['UNP-MIG-3'].startsWith('INV-2026-'), byRef['UNP-MIG-3']);
});

test('the VAT settings seed once and are never overwritten', async () => {
  // An admin who sets the registration number must not lose it on the next
  // deploy. ON CONFLICT DO NOTHING is what protects that; this proves it.
  await pool.query(
    `UPDATE settings SET value = '4999999999' WHERE key = 'vat_registration_number'`);
  await runAllMigrations();
  const r = await pool.query(
    `SELECT value FROM settings WHERE key = 'vat_registration_number'`);
  assert.equal(r.rows[0].value, '4999999999',
    'a deploy must not wipe the VAT number an admin set');
});

test('one invoice per order, enforced by the database', async () => {
  const dupe = pool.query(
    `INSERT INTO invoices (user_id, order_id, invoice_number, reference,
                           subtotal, total, method, status)
     SELECT user_id, order_id, 'INV-9999-000001', reference, total, total, 'eft', 'confirmed'
       FROM invoices LIMIT 1`);
  await assert.rejects(() => dupe, /duplicate key|unique/i,
    'a second invoice for one order must be refused by the constraint, not by luck');
});
