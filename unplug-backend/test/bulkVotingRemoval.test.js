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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-remove-bulk-'));
const port = 54800 + (process.pid % 300);

before(async () => {
  ensureStopWords();
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

  const dir = path.join(__dirname, '..', 'db', 'migrations');
  const files = fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort();
  for (const file of files.filter((x) => x !== '220_remove_bulk_voting.sql')) {
    await pool.query(fs.readFileSync(path.join(dir, file), 'utf8'));
  }

  await pool.query(`
    INSERT INTO users (id, email, full_name, password_hash, role)
    VALUES (998801, 'normal@test.com', 'Normal Voter', 'x', 'member');

    INSERT INTO competitions (id, name, slug, opens_at, closes_at, status)
    VALUES (998801, 'Removal Test', 'removal-test', now() - interval '1 day',
            now() + interval '30 days', 'open');

    INSERT INTO competition_entries (id, competition_id, manual_name, status)
    VALUES (998801, 998801, 'Legacy Mixed', 'approved'),
           (998802, 998801, 'Dedicated Paid', 'approved'),
           (998803, 998801, 'Normal Only', 'approved');
  `);

  // Legacy storage: one free individual vote plus 50 purchased votes were
  // merged into one row before vote_bundle_id existed.
  const legacy = await pool.query(`
    INSERT INTO vote_bundles
      (entry_id, buyer_user_id, vote_count, price, status, reference)
    VALUES (998801, 998801, 50, 20, 'confirmed', '9988010001')
    RETURNING id
  `);
  await pool.query(`
    INSERT INTO votes (entry_id, voter_user_id, bundle_size)
    VALUES (998801, 998801, 51)
  `);

  // Newer storage: the purchased quantity owns a dedicated tagged row.
  const dedicated = await pool.query(`
    INSERT INTO vote_bundles
      (entry_id, buyer_user_id, vote_count, price, status, reference)
    VALUES (998802, 998801, 70, 28, 'confirmed', '9988020001')
    RETURNING id
  `);
  await pool.query(`
    INSERT INTO votes (entry_id, voter_user_id, bundle_size, vote_bundle_id)
    VALUES (998802, 998801, 70, $1)
  `, [dedicated.rows[0].id]);

  // A completely unrelated normal individual vote must be untouched.
  await pool.query(`
    INSERT INTO votes (entry_id, voter_user_id, bundle_size, vote_day)
    VALUES (998803, 998801, 1, CURRENT_DATE)
  `);

  // Shared payments table may contain historical records for the retired
  // service; these should disappear without harming the shared table.
  await pool.query(`
    INSERT INTO payments
      (user_id, amount, method, gateway_reference, status, linked_type, linked_id)
    VALUES (998801, 20, 'eft', 'REMOVE-BULK-1', 'confirmed', 'vote_bundle', $1)
  `, [legacy.rows[0].id]);

  await pool.query(fs.readFileSync(path.join(dir, '220_remove_bulk_voting.sql'), 'utf8'));
});

after(async () => {
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
});

test('legacy mixed row keeps exactly the underlying individual vote', async () => {
  const r = await pool.query(
    'SELECT bundle_size FROM votes WHERE entry_id = 998801 AND voter_user_id = 998801'
  );
  assert.equal(r.rowCount, 1);
  assert.equal(r.rows[0].bundle_size, 1);
});

test('dedicated paid-vote row is removed while normal individual vote remains', async () => {
  const paid = await pool.query('SELECT COUNT(*)::int AS n FROM votes WHERE entry_id = 998802');
  const normal = await pool.query('SELECT bundle_size FROM votes WHERE entry_id = 998803');
  assert.equal(paid.rows[0].n, 0);
  assert.equal(normal.rowCount, 1);
  assert.equal(normal.rows[0].bundle_size, 1);
});

test('bulk-only schema and payment type are gone', async () => {
  const tables = await pool.query(`
    SELECT to_regclass('public.vote_bundles') AS bundles,
           to_regclass('public.vote_bundle_tiers') AS tiers
  `);
  assert.equal(tables.rows[0].bundles, null);
  assert.equal(tables.rows[0].tiers, null);

  const column = await pool.query(`
    SELECT COUNT(*)::int AS n
      FROM information_schema.columns
     WHERE table_name = 'votes' AND column_name = 'vote_bundle_id'
  `);
  assert.equal(column.rows[0].n, 0);

  const payments = await pool.query(
    "SELECT COUNT(*)::int AS n FROM payments WHERE linked_type = 'vote_bundle'"
  );
  assert.equal(payments.rows[0].n, 0);

  const constraint = await pool.query(`
    SELECT pg_get_constraintdef(oid) AS def
      FROM pg_constraint
     WHERE conname = 'payments_linked_type_check'
  `);
  assert.ok(!constraint.rows[0].def.includes('vote_bundle'));
});
