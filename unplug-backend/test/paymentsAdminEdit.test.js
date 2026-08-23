// Admin editing and deleting payments, over real HTTP against real PostgreSQL.
//
// Deleting a payment is the most destructive thing in the admin dashboard, so
// the guards get tested as attacks rather than as happy paths. The one that
// matters most: a payment already turned into ACCOUNT CREDIT must not be
// deletable. account_credits.payment_id is ON DELETE SET NULL and a unique
// index on it is the only thing stopping the same payment being credited
// twice — so deleting a credited payment would leave the money credited, erase
// where it came from, and disarm that guard at the same time.
//
// Run with:  npm test   (from unplug-backend/)

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const EmbeddedPostgres = require('embedded-postgres').default;
const { stopPostgres } = require('./helpers/stopPostgres');

let pg;
let pool;
let server;
let baseUrl;
let adminToken;
let memberToken;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-payedit-'));
const port = 8000 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

function migrationFiles() {
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
    .map((f) => path.join(dir, f));
}

async function req(method, urlPath, { token, body } = {}) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, body: json };
}

let refCounter = 0;
async function makePayment({ status = 'confirmed', linkedType = 'article_publish', linkedId = 1 } = {}) {
  refCounter += 1;
  const r = await pool.query(
    `INSERT INTO payments (user_id, amount, method, gateway_reference, linked_type, linked_id, status, confirmed_at)
     VALUES (50, 100.00, 'eft', $1, $2, $3, $4::varchar,
             CASE WHEN $4::varchar = 'confirmed' THEN now() ELSE NULL END)
     RETURNING id`,
    [`TESTREF${refCounter}`, linkedType, linkedId, status]
  );
  return r.rows[0].id;
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
  process.env.JWT_SECRET = 'test-secret-for-payment-admin';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const file of migrationFiles()) {
    await pool.query(fs.readFileSync(file, 'utf8'));
  }
  // Both the buyer and the admin must exist: account_credits.created_by is a
  // real foreign key to users.
  await pool.query(`INSERT INTO users (id, email, password_hash, role)
                    VALUES (50, 'payer@test', 'x', 'member'),
                           (1, 'admin@test', 'x', 'admin')
                    ON CONFLICT DO NOTHING`);

  const jwt = require('jsonwebtoken');
  adminToken = jwt.sign({ id: 1, email: 'admin@test', role: 'admin' }, process.env.JWT_SECRET);
  memberToken = jwt.sign({ id: 50, email: 'payer@test', role: 'member' }, process.env.JWT_SECRET);

  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/payments', require('../src/routes/payments'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}, { timeout: 120000 });

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (pool) await pool.end();
  // stopPostgres, not pg.stop() directly: on Windows the library's stop
  // can HANG rather than throw, which used to leave the cluster running
  // with no parent and eventually broke a later test file's startup.
  // See test/helpers/stopPostgres.js.
  await stopPostgres(pg, dataDir);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- permissions

test('members and visitors cannot edit or delete payments', async () => {
  const id = await makePayment();
  assert.equal((await req('PATCH', `/payments/admin/${id}`, { token: memberToken, body: { status: 'confirmed' } })).status, 403);
  assert.equal((await req('DELETE', `/payments/admin/${id}`, { token: memberToken })).status, 403);
  assert.equal((await req('DELETE', `/payments/admin/${id}`)).status, 401);

  const still = await pool.query('SELECT COUNT(*)::int AS n FROM payments WHERE id = $1', [id]);
  assert.equal(still.rows[0].n, 1, 'a member managed to delete a payment');
});

// ----------------------------------------------------------------------- edit

test('admin can mark a test payment as failed', async () => {
  const id = await makePayment({ status: 'confirmed' });
  const r = await req('PATCH', `/payments/admin/${id}`, { token: adminToken, body: { status: 'failed' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.payment.status, 'failed');

  const row = await pool.query('SELECT status, confirmed_at FROM payments WHERE id = $1', [id]);
  assert.equal(row.rows[0].status, 'failed');
  assert.equal(row.rows[0].confirmed_at, null, 'a failed payment should not keep a confirmation time');
});

test('an invalid status is refused', async () => {
  const id = await makePayment();
  assert.equal((await req('PATCH', `/payments/admin/${id}`, { token: adminToken, body: { status: 'refunded' } })).status, 400);
});

test('a payment already turned into credit cannot be un-confirmed', async () => {
  const id = await makePayment({ status: 'confirmed' });
  await pool.query(
    `INSERT INTO account_credits (user_id, amount, reason, payment_id, created_by)
     VALUES (50, 100.00, 'cancelled_service', $1, 1)`, [id]
  );

  const r = await req('PATCH', `/payments/admin/${id}`, { token: adminToken, body: { status: 'failed' } });
  assert.equal(r.status, 409);

  const row = await pool.query('SELECT status FROM payments WHERE id = $1', [id]);
  assert.equal(row.rows[0].status, 'confirmed', 'the customer now has credit with no confirmed payment behind it');
});

// --------------------------------------------------------------------- delete

test('a test payment with nothing attached can be deleted', async () => {
  const id = await makePayment({ status: 'pending' });
  const r = await req('DELETE', `/payments/admin/${id}`, { token: adminToken });
  assert.equal(r.status, 200);

  const gone = await pool.query('SELECT COUNT(*)::int AS n FROM payments WHERE id = $1', [id]);
  assert.equal(gone.rows[0].n, 0);
});

test('a payment that granted ACCOUNT CREDIT cannot be deleted', async () => {
  const id = await makePayment({ status: 'confirmed' });
  await pool.query(
    `INSERT INTO account_credits (user_id, amount, reason, payment_id, created_by)
     VALUES (50, 100.00, 'cancelled_service', $1, 1)`, [id]
  );

  const r = await req('DELETE', `/payments/admin/${id}`, { token: adminToken });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /Failed/, 'the refusal should say what to do instead');

  const kept = await pool.query(
    `SELECT (SELECT COUNT(*)::int FROM payments WHERE id = $1) AS pay,
            (SELECT COUNT(*)::int FROM account_credits WHERE payment_id = $1) AS credit`, [id]
  );
  assert.equal(kept.rows[0].pay, 1, 'a credited payment was deleted');
  assert.equal(kept.rows[0].credit, 1, 'the credit lost its link to its payment');
});

test('a payment behind an edition purchase cannot be deleted', async () => {
  const id = await makePayment({ status: 'confirmed', linkedType: 'edition_download' });
  await pool.query(
    `INSERT INTO editions (issue_number, title, pdf_url) VALUES (801, 'Paid Edition', 'https://x/e.pdf')`
  );
  const ed = await pool.query(`SELECT id FROM editions WHERE issue_number = 801`);
  await pool.query(
    `INSERT INTO edition_purchases (user_id, edition_id, payment_id, payment_status)
     VALUES (50, $1, $2, 'approved')`, [ed.rows[0].id, id]
  );

  const r = await req('DELETE', `/payments/admin/${id}`, { token: adminToken });
  assert.equal(r.status, 409);

  const kept = await pool.query('SELECT COUNT(*)::int AS n FROM edition_purchases WHERE payment_id = $1', [id]);
  assert.equal(kept.rows[0].n, 1, "the customer's edition purchase lost its payment");
});

test('a payment behind paid votes cannot be deleted', async () => {
  const id = await makePayment({ status: 'confirmed', linkedType: 'vote_bundle' });
  const comp = await pool.query(`SELECT id FROM competitions WHERE slug = 'top-10'`);
  await pool.query(`INSERT INTO competition_entries (id, competition_id, profile_id, manual_name, entry_fee, status)
                    VALUES (900, $1, NULL, 'Voted For', 0, 'approved') ON CONFLICT DO NOTHING`, [comp.rows[0].id]);
  await pool.query(
    `INSERT INTO votes (entry_id, session_id, bundle_size, payment_id) VALUES (900, 'sess-pay', 5, $1)`, [id]
  );

  const r = await req('DELETE', `/payments/admin/${id}`, { token: adminToken });
  assert.equal(r.status, 409);

  const kept = await pool.query('SELECT COUNT(*)::int AS n FROM votes WHERE payment_id = $1', [id]);
  assert.equal(kept.rows[0].n, 1, 'paid votes were destroyed');
});

test('deleting a banner payment keeps the banner, with its payment link cleared', async () => {
  // ad_slots.payment_id is ON DELETE SET NULL, so this one is allowed — but the
  // admin should be told the banner survived rather than discovering it later.
  const id = await makePayment({ status: 'confirmed', linkedType: 'ad_banner' });
  await pool.query(
    `INSERT INTO ad_slots (slot_key, image_url, payment_id, is_active)
     VALUES ('home-sponsor-1', 'https://x/b.jpg', $1, true)`, [id]
  );

  const r = await req('DELETE', `/payments/admin/${id}`, { token: adminToken });
  assert.equal(r.status, 200);
  assert.equal(r.body.bannersDetached, 1);

  const banner = await pool.query(`SELECT payment_id FROM ad_slots WHERE image_url = 'https://x/b.jpg'`);
  assert.equal(banner.rowCount, 1, 'the banner was deleted along with its payment');
  assert.equal(banner.rows[0].payment_id, null);
});

test('deleting a payment that does not exist is a clean 404', async () => {
  assert.equal((await req('DELETE', '/payments/admin/999999', { token: adminToken })).status, 404);
});

// ------------------------------------------------------------------- contract

test('the admin list returns payments under the key the dashboard reads', async () => {
  // This exact mismatch shipped once: the route returns `orders`, the panel
  // read `payments`, so the screen said "No payments recorded" while payments
  // existed. Nothing threw — it just silently showed nothing.
  const id = await makePayment({ status: 'pending' });
  const r = await req('GET', '/payments/admin/all', { token: adminToken });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.orders), 'the admin list must return an `orders` array');
  const found = r.body.orders.find((o) => o.id === id);
  assert.ok(found, 'a payment that exists is missing from the admin list');
  // Fields the dashboard renders for each row.
  ['gateway_reference', 'linked_type', 'amount', 'status', 'created_at', 'email']
    .forEach((f) => assert.ok(f in found, `the admin list row is missing ${f}`));
});
