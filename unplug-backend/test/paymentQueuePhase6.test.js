// Payment Portal Redevelopment — Phase 6: proof-of-payment upload, generated
// invoice/receipt documents, and the unified cross-portal admin queue
// (097_payment_receipts.sql, routes/adminPaymentQueue.js, utils/pdfDocs.js).
//
// The central claim under test is that the admin queue safely merges the
// remaining payment and cart-order sources, and preserves proof-of-payment
// ownership rules.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-payqueue-'));
const port = 29200 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

async function req(method, urlPath, { token, body } = {}) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, body: json };
}

let jwt;
function tokenFor(userId, role = 'member') {
  return jwt.sign({ id: userId, email: `payqueue${userId}@test.com`, role }, process.env.JWT_SECRET);
}

let _nextUserId = 27000;
async function makeUser(role = 'member') {
  const id = _nextUserId++;
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role, full_name) VALUES ($1, $2, 'x', $3, $4) ON CONFLICT DO NOTHING`,
    [id, `payqueue${id}@test.com`, role, `Pay Queue ${id}`]
  );
  return id;
}

let _refCounter = 0;
function uniqueRef(prefix) {
  _refCounter += 1;
  return `${prefix}-${process.pid}-${_refCounter}`;
}



// A standalone payment — order_id NULL, which is what makes it show up in
// the queue in its own right rather than folded under a parent order.
async function makeStandalonePayment(userId, { status = 'pending', amount = 95 } = {}) {
  const r = await pool.query(
    `INSERT INTO payments (user_id, amount, method, gateway_reference, linked_type, linked_id,
                           order_total, voucher_discount, credit_used, status, terms_version)
     VALUES ($1, $2, 'eft', $3, 'article_publish', 1, $4, 0, 0, $5, 'v1') RETURNING *`,
    [userId, amount, uniqueRef('PAY'), amount, status]
  );
  return r.rows[0];
}

async function makeOrder(userId, { status = 'pending' } = {}) {
  const reference = uniqueRef('UNP');
  const order = await pool.query(
    `INSERT INTO orders (user_id, reference, method, status, subtotal, total, terms_version,
                         terms_accepted_at, info_confirmed_at)
     VALUES ($1, $2, 'eft', $3, 395, 395, 'v1', now(), now()) RETURNING *`,
    [userId, reference, status]
  );
  // Two real payments rows under it, exactly as the cart creates them.
  await pool.query(
    `INSERT INTO payments (user_id, amount, method, gateway_reference, linked_type, linked_id,
                           order_total, status, terms_version, order_id)
     VALUES ($1, 95, 'eft', $2, 'article_publish', 1, 95, $4, 'v1', $3),
            ($1, 300, 'eft', $5, 'event_listing', 1, 300, $4, 'v1', $3)`,
    [userId, `${reference}-1`, order.rows[0].id, status, `${reference}-2`]
  );
  return order.rows[0];
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
  process.env.JWT_SECRET = 'test-secret-for-payqueue';
  process.env.UNPLUG_DISABLE_RATE_LIMITS = '1';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }

  jwt = require('jsonwebtoken');

  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/admin/payment-queue', require('../src/routes/adminPaymentQueue'));
  app.use('/payments', require('../src/routes/payments'));
  app.use('/orders', require('../src/routes/orders'));
  app.use('/', require('../src/routes/competitions'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await pool.end();
  // stopPostgres, not pg.stop() directly: on Windows the library's stop
  // can HANG rather than throw, which used to leave the cluster running
  // with no parent and eventually broke a later test file's startup.
  // See test/helpers/stopPostgres.js.
  await stopPostgres(pg, dataDir);
});

// ---------------------------------------------------------------------------
// Proof of payment — who is allowed to attach one
// ---------------------------------------------------------------------------

test('a payer can attach proof of payment to their own payment', async () => {
  const user = await makeUser();
  const payment = await makeStandalonePayment(user);
  const { status, body } = await req('PATCH', `/payments/${payment.id}/proof`, {
    token: tokenFor(user), body: { url: 'https://storage.test/private/proof1.png' },
  });
  assert.equal(status, 200);
  assert.equal(body.payment.pop_url, 'https://storage.test/private/proof1.png');
});

test('a payer CANNOT attach proof of payment to somebody else\'s payment', async () => {
  const owner = await makeUser();
  const stranger = await makeUser();
  const payment = await makeStandalonePayment(owner);
  const { status } = await req('PATCH', `/payments/${payment.id}/proof`, {
    token: tokenFor(stranger), body: { url: 'https://storage.test/private/evil.png' },
  });
  assert.equal(status, 404);

  // And the real owner's row is untouched.
  const check = await pool.query(`SELECT pop_url FROM payments WHERE id = $1`, [payment.id]);
  assert.equal(check.rows[0].pop_url, null);
});

test('an order owner can attach proof of payment to their own order', async () => {
  const user = await makeUser();
  const order = await makeOrder(user);
  const { status, body } = await req('PATCH', `/orders/${order.id}/proof`, {
    token: tokenFor(user), body: { url: 'https://storage.test/private/order-proof.pdf' },
  });
  assert.equal(status, 200);
  assert.equal(body.order.pop_url, 'https://storage.test/private/order-proof.pdf');
});

test('the unified queue is admin-only', async () => {
  const member = await makeUser();
  const { status } = await req('GET', '/admin/payment-queue', { token: tokenFor(member) });
  assert.equal(status, 403);
});

test('the individual payments inside a cart order do NOT also appear as their own queue rows', async () => {
  const admin = await makeUser('admin');
  const user = await makeUser();
  const order = await makeOrder(user);

  const { body } = await req('GET', '/admin/payment-queue', { token: tokenFor(admin, 'admin') });
  // The cart creates item references as `${orderReference}-1`, `-2`. If
  // order-linked payments leaked into the list, these would be present too
  // and the admin would see the same money three times.
  const leaked = body.items.filter((i) => i.reference === `${order.reference}-1` || i.reference === `${order.reference}-2`);
  assert.equal(leaked.length, 0);
});

test('the queue can be filtered by status across every source at once', async () => {
  const admin = await makeUser('admin');
  const user = await makeUser();
  const confirmedPayment = await makeStandalonePayment(user, { status: 'confirmed' });
  await makeStandalonePayment(user, { status: 'pending' });

  const { body } = await req('GET', '/admin/payment-queue?status=confirmed', { token: tokenFor(admin, 'admin') });
  assert.ok(body.items.every((i) => i.status === 'confirmed'));
  assert.ok(body.items.some((i) => i.reference === confirmedPayment.gateway_reference));
});

test('the queue search matches a reference', async () => {
  const admin = await makeUser('admin');
  const user = await makeUser();
  const payment = await makeStandalonePayment(user);

  const { body } = await req('GET', `/admin/payment-queue?q=${encodeURIComponent(payment.gateway_reference)}`, {
    token: tokenFor(admin, 'admin'),
  });
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].reference, payment.gateway_reference);
});

test('a proof-of-payment attached by the customer is visible to the admin in the queue', async () => {
  const admin = await makeUser('admin');
  const user = await makeUser();
  const payment = await makeStandalonePayment(user);
  await req('PATCH', `/payments/${payment.id}/proof`, {
    token: tokenFor(user), body: { url: 'https://storage.test/private/seen-by-admin.png' },
  });

  const { body } = await req('GET', `/admin/payment-queue?q=${encodeURIComponent(payment.gateway_reference)}`, {
    token: tokenFor(admin, 'admin'),
  });
  assert.equal(body.items[0].popUrl, 'https://storage.test/private/seen-by-admin.png');
});

test('viewing a proof that was never uploaded says so rather than erroring', async () => {
  const admin = await makeUser('admin');
  const user = await makeUser();
  const payment = await makeStandalonePayment(user);
  const { status } = await req('GET', `/admin/payment-queue/payment/${payment.id}/proof`, {
    token: tokenFor(admin, 'admin'),
  });
  assert.equal(status, 404);
});

test('an unknown source is rejected rather than being interpolated into SQL', async () => {
  const admin = await makeUser('admin');
  const { status, body } = await req('GET', '/admin/payment-queue/users/1/proof', {
    token: tokenFor(admin, 'admin'),
  });
  assert.equal(status, 400);
  assert.match(body.error, /payment or order/);
});

// ---------------------------------------------------------------------------
// Rejecting a cart order
// ---------------------------------------------------------------------------

test('an admin can reject a pending order, and every item in it is marked failed', async () => {
  const admin = await makeUser('admin');
  const user = await makeUser();
  const order = await makeOrder(user);

  const { status, body } = await req('PATCH', `/orders/admin/${order.id}/reject`, { token: tokenFor(admin, 'admin') });
  assert.equal(status, 200);
  assert.equal(body.creditReturned, 0);

  const after = await pool.query(`SELECT status FROM orders WHERE id = $1`, [order.id]);
  assert.equal(after.rows[0].status, 'failed');
  const items = await pool.query(`SELECT status FROM payments WHERE order_id = $1`, [order.id]);
  assert.ok(items.rows.length > 0);
  assert.ok(items.rows.every((r) => r.status === 'failed'), 'every item in the order should be failed too');
});

test('rejecting an order RETURNS any account credit that was spent on it', async () => {
  // The costly case: the customer paid with credit, so rejecting without
  // refunding would take real money and deliver nothing.
  const admin = await makeUser('admin');
  const user = await makeUser();
  await pool.query(
    `INSERT INTO account_credits (user_id, amount, reason, note) VALUES ($1, 200, 'admin_adjustment', 'test grant')`,
    [user]
  );
  const order = await makeOrder(user);
  // Mirror what checkout does: spend R150 of that credit against this order.
  await pool.query(
    `INSERT INTO account_credits (user_id, amount, reason, note) VALUES ($1, -150, 'spent_at_checkout', $2)`,
    [user, `Applied to order ${order.reference}`]
  );
  await pool.query(`UPDATE orders SET credit_used = 150 WHERE id = $1`, [order.id]);

  const balanceBefore = await pool.query(`SELECT COALESCE(SUM(amount),0)::numeric AS b FROM account_credits WHERE user_id = $1`, [user]);
  assert.equal(Number(balanceBefore.rows[0].b), 50);

  const { status, body } = await req('PATCH', `/orders/admin/${order.id}/reject`, { token: tokenFor(admin, 'admin') });
  assert.equal(status, 200);
  assert.equal(body.creditReturned, 150);

  const balanceAfter = await pool.query(`SELECT COALESCE(SUM(amount),0)::numeric AS b FROM account_credits WHERE user_id = $1`, [user]);
  assert.equal(Number(balanceAfter.rows[0].b), 200, 'the spent credit should be back');
});

test('an already-confirmed order cannot be rejected — its services have already been delivered', async () => {
  const admin = await makeUser('admin');
  const user = await makeUser();
  const order = await makeOrder(user, { status: 'confirmed' });
  const { status, body } = await req('PATCH', `/orders/admin/${order.id}/reject`, { token: tokenFor(admin, 'admin') });
  assert.equal(status, 400);
  assert.match(body.error, /already been confirmed/);
});

test('rejecting an order is admin-only', async () => {
  const user = await makeUser();
  const order = await makeOrder(user);
  const { status } = await req('PATCH', `/orders/admin/${order.id}/reject`, { token: tokenFor(user) });
  assert.equal(status, 403);
});

// ---------------------------------------------------------------------------
// Generated documents
// ---------------------------------------------------------------------------

test('generateDocument produces a real PDF with the order breakdown on it', async () => {
  const { generateDocument } = require('../src/utils/pdfDocs');
  const buffer = await generateDocument({
    kind: 'receipt',
    reference: 'UNP-TEST-DOC',
    customerName: 'Test Person',
    customerEmail: 'test@example.com',
    items: [{ label: 'Article Submission', amount: 95 }, { label: 'Event Listing', amount: 300 }],
    subtotal: 395, voucherDiscount: 20, creditUsed: 50, total: 325,
    method: 'eft', status: 'confirmed', date: '2026/08/07',
  });
  assert.ok(Buffer.isBuffer(buffer));
  assert.equal(buffer.subarray(0, 5).toString(), '%PDF-');
  assert.ok(buffer.length > 1000, 'a real document, not an empty shell');
});

test('an invoice cannot be generated when file storage is not configured — and says so instead of failing silently', async () => {
  // No R2_* env vars are set in the test environment, which is exactly
  // the "storage not configured" case a fresh deployment starts in.
  const admin = await makeUser('admin');
  const user = await makeUser();
  const payment = await makeStandalonePayment(user);
  const { status, body } = await req('POST', `/admin/payment-queue/payment/${payment.id}/generate-invoice`, {
    token: tokenFor(admin, 'admin'),
  });
  assert.equal(status, 400);
  assert.match(body.error, /storage is not configured/i);
});

test('emailing a real customer succeeds (logged, not sent, with no provider configured)', async () => {
  const admin = await makeUser('admin');
  const user = await makeUser();
  const payment = await makeStandalonePayment(user);
  const { status, body } = await req('POST', `/admin/payment-queue/payment/${payment.id}/email`, {
    token: tokenFor(admin, 'admin'), body: { note: 'Just checking in on this one.' },
  });
  assert.equal(status, 200);
  assert.match(body.message, /Email sent to/);
});
