// Credit-system tests against a REAL PostgreSQL.
//
// The account-credit code makes three promises that live in the database, not
// in JavaScript, and so can't be checked by reading the code:
//
//   1. the same payment can't be credited twice (partial unique index);
//   2. two checkouts spending credit at once can't overspend it (FOR UPDATE);
//   3. crediting and rejecting happen together or not at all (transaction).
//
// A fake/in-memory Postgres emulates exactly these features poorly, which is
// the whole reason this uses embedded-postgres: it downloads and runs a real
// PostgreSQL binary on a throwaway port, so the guarantees are proven by the
// same engine that runs in production, then torn down.
//
// Run with:  npm test   (from unplug-backend/)

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
// The package is published as an ES module transpiled to CJS, so the class is
// under .default when required.
const EmbeddedPostgres = require('embedded-postgres').default;

let pg;
let pool;
let credit;         // required lazily, AFTER DATABASE_URL is set
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-pgtest-'));
// A high, fixed-ish port derived from the pid to avoid clashing with a real
// local Postgres on 5432.
const port = 5610 + (process.pid % 300);

before(async () => {
  pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: false,
    // Force a UTF-8 cluster. Production (Supabase) is UTF-8, but on Windows
    // initdb defaults to the system locale (WIN1252), which can't store the
    // UTF-8 characters (e.g. "→") that appear in the seed migrations. Without
    // this the migrations fail on Windows only, for a reason that has nothing
    // to do with what's being tested.
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('unplug_test');

  process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${port}/unplug_test`;

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });

  // Apply every migration in order, exactly as db/migrate.js does in production.
  const migrationsDir = path.join(__dirname, '..', 'db', 'migrations');
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    await pool.query(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
  }

  // Now that DATABASE_URL points at the test database, load the module under
  // test — it builds its pool from that env var at require time.
  credit = require('../src/utils/accountCredit');
}, { timeout: 120000 });

after(async () => {
  if (pool) await pool.end();
  if (pg) await pg.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// A member and a confirmed R100 payment to credit against. Returns their ids.
async function seedUserAndPayment(amount = 100) {
  const u = await pool.query(
    `INSERT INTO users (email, password_hash, role)
     VALUES ($1, 'x', 'member') RETURNING id`,
    [`m${Date.now()}-${Math.random()}@example.com`]
  );
  const userId = u.rows[0].id;
  const p = await pool.query(
    `INSERT INTO payments (user_id, amount, method, gateway_reference, linked_type, linked_id, status)
     VALUES ($1, $2, 'eft', $3, 'article_publish', 1, 'confirmed') RETURNING id`,
    [userId, amount, `ref-${Date.now()}-${Math.random()}`]
  );
  return { userId, paymentId: p.rows[0].id };
}

test('a payment can be credited exactly once', async () => {
  const { userId, paymentId } = await seedUserAndPayment(100);

  await pool.query(
    `INSERT INTO account_credits (user_id, amount, reason, payment_id)
     VALUES ($1, 100, 'declined_submission', $2)`,
    [userId, paymentId]
  );
  assert.equal(await credit.balanceFor(userId), 100, 'first credit lands');

  // The second insert for the same payment must be rejected by the partial
  // unique index — this is the real guard against double-crediting, not an
  // application-level check that could race.
  await assert.rejects(
    () => pool.query(
      `INSERT INTO account_credits (user_id, amount, reason, payment_id)
       VALUES ($1, 100, 'declined_submission', $2)`,
      [userId, paymentId]
    ),
    (err) => err.code === '23505',
    'a second credit for the same payment is blocked by the unique index'
  );
  assert.equal(await credit.balanceFor(userId), 100, 'balance is unchanged after the blocked attempt');
});

test('concurrent checkouts cannot overspend the same credit', async () => {
  const { userId } = await seedUserAndPayment();
  // Give them exactly R100 of credit (no payment link needed for a grant).
  await pool.query(
    `INSERT INTO account_credits (user_id, amount, reason) VALUES ($1, 100, 'admin_adjustment')`,
    [userId]
  );

  // Two checkouts, each wanting to spend R80, firing at the same time. Only
  // R100 exists. Without the row lock in spendCredit both would read R100 and
  // each deduct R80, leaving the account at -R60. With it, the second waits,
  // sees R20, and spends only that.
  async function checkout() {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const used = await credit.spendCredit(client, userId, 80, 'concurrent test');
      await client.query('COMMIT');
      return used;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  const [a, b] = await Promise.all([checkout(), checkout()]);
  const totalSpent = a + b;
  assert.equal(totalSpent, 100, 'together they spend exactly the R100 available, never more');
  assert.equal(await credit.balanceFor(userId), 0, 'balance lands at zero, never negative');
});

test('crediting and rejecting are atomic — a failure rolls back the credit', async () => {
  const { userId, paymentId } = await seedUserAndPayment();

  // Mimic the decline-with-credit handler, but force a failure AFTER the credit
  // insert (a bad UPDATE) to prove the credit doesn't persist on its own.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO account_credits (user_id, amount, reason, payment_id)
       VALUES ($1, 100, 'declined_submission', $2)`,
      [userId, paymentId]
    );
    // This statement errors (no such column), standing in for any later step
    // of the handler failing.
    await client.query(`UPDATE articles SET no_such_column = 1 WHERE id = $1`, [1]);
    await client.query('COMMIT');
    assert.fail('the bad UPDATE should have thrown');
  } catch (err) {
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }

  assert.equal(
    await credit.balanceFor(userId), 0,
    'the credit was rolled back with the rest of the transaction — the member was not credited for a decline that did not complete'
  );
});
