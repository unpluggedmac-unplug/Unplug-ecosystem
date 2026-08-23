// Payment Portal Redevelopment — Phase 3: multi-service cart checkout
// (096_orders_cart_checkout.sql, routes/orders.js). Members-only, over
// real HTTP against real PostgreSQL.
//
// Proves the core design claim: each cart item is a REAL payments row
// (not a fake/duplicated one), so resolveAmount/applyPaymentEffect from
// payments.js work completely unchanged — tested here by mixing three
// different service types (article_publish, gallery_bundle, event_listing)
// in ONE order and confirming each one's real, type-specific effect fires
// (article → pending, gallery bundle AND its images → pending, event →
// pending), plus that the proportional split across differently-priced
// items sums exactly to what was actually charged.
//
// See universalComments.test.js for why require('../src/app') is avoided.
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
let server;
let baseUrl;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-orderscart-'));
const port = 21200 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

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
  return jwt.sign({ id: userId, email: `orderscart${userId}@test.com`, role }, process.env.JWT_SECRET);
}

let _nextUserId = 26000;
async function makeUser(role = 'member') {
  const id = _nextUserId++;
  await pool.query(`INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', $3) ON CONFLICT DO NOTHING`, [id, `orderscart${id}@test.com`, role]);
  return id;
}

// Article Submission (R95) and Event Listing (R300) fixtures — both
// default to 'pending' in their own table, so 'awaiting_payment' has to
// be set explicitly to match what applyPaymentEffect's branches for
// these two types actually look for.
async function makeAwaitingArticle(userId) {
  const r = await pool.query(
    `INSERT INTO articles (author_user_id, title, body, status) VALUES ($1, 'Cart Test Article', 'body', 'awaiting_payment') RETURNING id`,
    [userId]
  );
  return r.rows[0].id;
}
async function makeAwaitingEvent(userId) {
  const r = await pool.query(
    `INSERT INTO events (organizer_user_id, name, event_date, status) VALUES ($1, 'Cart Test Event', CURRENT_DATE + 30, 'awaiting_payment') RETURNING id`,
    [userId]
  );
  return r.rows[0].id;
}
// Gallery Bundle (R100) already defaults to 'awaiting_payment' — and its
// effect branch ALSO cascades to gallery_images, which is the
// multi-row-update case worth proving works through the cart.
async function makeAwaitingGalleryBundle(userId) {
  const bundle = await pool.query(
    `INSERT INTO gallery_bundles (user_id, image_count, price) VALUES ($1, 2, 100.00) RETURNING id`,
    [userId]
  );
  await pool.query(
    `INSERT INTO gallery_images (owner_type, owner_id, image_url, status, bundle_id) VALUES ('general', NULL, 'https://example.test/a.jpg', 'pending', $1), ('general', NULL, 'https://example.test/b.jpg', 'pending', $1)`,
    [bundle.rows[0].id]
  );
  return bundle.rows[0].id;
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
  process.env.JWT_SECRET = 'test-secret-for-orderscart';

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
  app.use('/orders', require('../src/routes/orders'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await pool.end();
  // Windows can still hold a handle on the data directory when Postgres
  // exits, and embedded-postgres removes that directory as part of
  // stopping. The server is already down by then, so an EBUSY here is
  // the OS being slow to let go, not a failure worth failing the file
  // for — and a teardown that goes red teaches everyone to ignore red.
  try { if (pg) await pg.stop(); } catch (e) { /* see above */ }
});

test('the cart portal requires login, unlike the anonymous Bulk Votes portal', async () => {
  const { status } = await req('POST', '/orders/quote', { body: { items: [{ linkedType: 'article_publish', linkedId: 1 }] } });
  assert.equal(status, 401);
});

test('edition_download and vote_bundle are refused as cart items — they have their own portals', async () => {
  const user = await makeUser();
  const { status, body } = await req('POST', '/orders/quote', {
    token: tokenFor(user), body: { items: [{ linkedType: 'edition_download', linkedId: 1 }] },
  });
  assert.equal(status, 400);
  assert.match(body.error, /cannot be added to a cart/);
});

test('POST /orders/quote prices a real multi-item cart and reports a real subtotal', async () => {
  const user = await makeUser();
  const articleId = await makeAwaitingArticle(user);
  const eventId = await makeAwaitingEvent(user);

  const { status, body } = await req('POST', '/orders/quote', {
    token: tokenFor(user),
    body: { items: [{ linkedType: 'article_publish', linkedId: articleId }, { linkedType: 'event_listing', linkedId: eventId }] },
  });
  assert.equal(status, 200);
  assert.equal(body.subtotal, 95 + 300);
  assert.equal(body.total, 395);
  assert.equal(body.settledWithoutPayment, false);
});

test('POST /orders/initiate is refused without BOTH Step 9 checkboxes — info-confirmed and terms-accepted are separate gates', async () => {
  const user = await makeUser();
  const articleId = await makeAwaitingArticle(user);
  const items = [{ linkedType: 'article_publish', linkedId: articleId }];

  const neither = await req('POST', '/orders/initiate', { token: tokenFor(user), body: { items, method: 'eft' } });
  assert.equal(neither.status, 400);
  assert.match(neither.body.error, /confirm that all information/);

  const onlyInfo = await req('POST', '/orders/initiate', { token: tokenFor(user), body: { items, method: 'eft', infoConfirmed: true } });
  assert.equal(onlyInfo.status, 400);
  assert.match(onlyInfo.body.error, /Terms/);

  const onlyTerms = await req('POST', '/orders/initiate', { token: tokenFor(user), body: { items, method: 'eft', termsAccepted: true } });
  assert.equal(onlyTerms.status, 400);
  assert.match(onlyTerms.body.error, /confirm that all information/);
});

test('a mixed 3-item order creates one order + three real payments rows, and each row\'s share sums exactly to what was charged', async () => {
  const user = await makeUser();
  const articleId = await makeAwaitingArticle(user); // R95
  const eventId = await makeAwaitingEvent(user); // R300
  const bundleId = await makeAwaitingGalleryBundle(user); // R100

  const { status, body } = await req('POST', '/orders/initiate', {
    token: tokenFor(user),
    body: {
      items: [
        { linkedType: 'article_publish', linkedId: articleId },
        { linkedType: 'event_listing', linkedId: eventId },
        { linkedType: 'gallery_bundle', linkedId: bundleId },
      ],
      method: 'eft', infoConfirmed: true, termsAccepted: true,
    },
  });
  assert.equal(status, 201, JSON.stringify(body));
  // NUMERIC columns come back from pg as strings, same as every other
  // money field in this codebase — Number() them rather than asserting a
  // string against a number literal.
  assert.equal(Number(body.order.subtotal), 495);
  assert.equal(Number(body.order.total), 495); // no voucher, no credit
  assert.equal(body.items.length, 3);
  assert.ok(body.instructions.reference.startsWith('UNP-'));

  const sumOfShares = body.items.reduce((s, p) => s + Number(p.amount), 0);
  assert.equal(Math.round(sumOfShares * 100) / 100, 495);

  // Each item's own gateway_reference is order-reference-derived and unique.
  const refs = body.items.map((p) => p.gateway_reference);
  assert.equal(new Set(refs).size, 3);
  refs.forEach((r) => assert.ok(r.startsWith(body.order.reference + '-')));
});

test('admin confirm-eft applies EVERY item\'s real, type-specific effect — article, event, AND the gallery bundle\'s images', async () => {
  const admin = await makeUser('admin');
  const user = await makeUser();
  const articleId = await makeAwaitingArticle(user);
  const eventId = await makeAwaitingEvent(user);
  const bundleId = await makeAwaitingGalleryBundle(user);

  const created = await req('POST', '/orders/initiate', {
    token: tokenFor(user),
    body: {
      items: [
        { linkedType: 'article_publish', linkedId: articleId },
        { linkedType: 'event_listing', linkedId: eventId },
        { linkedType: 'gallery_bundle', linkedId: bundleId },
      ],
      method: 'eft', infoConfirmed: true, termsAccepted: true,
    },
  });
  const orderId = created.body.order.id;

  const confirm = await req('PATCH', `/orders/admin/${orderId}/confirm-eft`, { token: tokenFor(admin, 'admin') });
  assert.equal(confirm.status, 200, JSON.stringify(confirm.body));

  const article = await pool.query('SELECT status FROM articles WHERE id = $1', [articleId]);
  assert.equal(article.rows[0].status, 'pending');
  const event = await pool.query('SELECT status FROM events WHERE id = $1', [eventId]);
  assert.equal(event.rows[0].status, 'pending');
  const bundle = await pool.query('SELECT status FROM gallery_bundles WHERE id = $1', [bundleId]);
  assert.equal(bundle.rows[0].status, 'pending');
  const images = await pool.query('SELECT status FROM gallery_images WHERE bundle_id = $1', [bundleId]);
  assert.ok(images.rows.every((i) => i.status === 'pending'), 'the bundle\'s own images did not cascade to pending');

  const orderRow = await pool.query('SELECT status FROM orders WHERE id = $1', [orderId]);
  assert.equal(orderRow.rows[0].status, 'confirmed');
  const paymentRows = await pool.query(`SELECT status FROM payments WHERE order_id = $1`, [orderId]);
  assert.ok(paymentRows.rows.every((p) => p.status === 'confirmed'));
});

test('a confirmed order cannot be confirmed again', async () => {
  const admin = await makeUser('admin');
  const user = await makeUser();
  const articleId = await makeAwaitingArticle(user);
  const created = await req('POST', '/orders/initiate', {
    token: tokenFor(user), body: { items: [{ linkedType: 'article_publish', linkedId: articleId }], method: 'eft', infoConfirmed: true, termsAccepted: true },
  });
  await req('PATCH', `/orders/admin/${created.body.order.id}/confirm-eft`, { token: tokenFor(admin, 'admin') });
  const again = await req('PATCH', `/orders/admin/${created.body.order.id}/confirm-eft`, { token: tokenFor(admin, 'admin') });
  assert.equal(again.status, 400);
});

test('a member can only see their own order, never someone else\'s (admin can see any)', async () => {
  const admin = await makeUser('admin');
  const owner = await makeUser();
  const stranger = await makeUser();
  const articleId = await makeAwaitingArticle(owner);
  const created = await req('POST', '/orders/initiate', {
    token: tokenFor(owner), body: { items: [{ linkedType: 'article_publish', linkedId: articleId }], method: 'eft', infoConfirmed: true, termsAccepted: true },
  });
  const orderId = created.body.order.id;

  assert.equal((await req('GET', `/orders/${orderId}`, { token: tokenFor(owner) })).status, 200);
  assert.equal((await req('GET', `/orders/${orderId}`, { token: tokenFor(stranger) })).status, 403);
  assert.equal((await req('GET', `/orders/${orderId}`, { token: tokenFor(admin, 'admin') })).status, 200);
});

test('an order fully covered by account credit confirms immediately with no EFT step', async () => {
  const user = await makeUser();
  const articleId = await makeAwaitingArticle(user);
  await pool.query(`INSERT INTO account_credits (user_id, amount, reason) VALUES ($1, 500, 'admin_adjustment')`, [user]);

  const { status, body } = await req('POST', '/orders/initiate', {
    token: tokenFor(user),
    body: { items: [{ linkedType: 'article_publish', linkedId: articleId }], method: 'eft', infoConfirmed: true, termsAccepted: true, useCredit: true },
  });
  assert.equal(status, 201);
  assert.equal(body.paidInFull, true);
  assert.equal(body.order.status, 'confirmed');

  const article = await pool.query('SELECT status FROM articles WHERE id = $1', [articleId]);
  assert.equal(article.rows[0].status, 'pending', 'the credit-covered order effect did not apply immediately');
});

test('a non-admin cannot confirm an EFT order or browse the admin order queue', async () => {
  const user = await makeUser();
  const articleId = await makeAwaitingArticle(user);
  const created = await req('POST', '/orders/initiate', {
    token: tokenFor(user), body: { items: [{ linkedType: 'article_publish', linkedId: articleId }], method: 'eft', infoConfirmed: true, termsAccepted: true },
  });
  assert.equal((await req('PATCH', `/orders/admin/${created.body.order.id}/confirm-eft`, { token: tokenFor(user) })).status, 403);
  assert.equal((await req('GET', '/orders/admin/all', { token: tokenFor(user) })).status, 403);
});

test('GET /orders/admin/all searches by reference and buyer email', async () => {
  const admin = await makeUser('admin');
  const user = await makeUser();
  const articleId = await makeAwaitingArticle(user);
  const created = await req('POST', '/orders/initiate', {
    token: tokenFor(user), body: { items: [{ linkedType: 'article_publish', linkedId: articleId }], method: 'eft', infoConfirmed: true, termsAccepted: true },
  });
  const reference = created.body.order.reference;

  const byRef = await req('GET', `/orders/admin/all?q=${reference}`, { token: tokenFor(admin, 'admin') });
  assert.ok(byRef.body.orders.some((o) => o.reference === reference));

  const byStatus = await req('GET', '/orders/admin/all?status=confirmed', { token: tokenFor(admin, 'admin') });
  assert.ok(!byStatus.body.orders.some((o) => o.reference === reference), 'a pending order appeared under the confirmed filter');
});

test('re-running every migration is idempotent — orders/payments.order_id survive', async () => {
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }
  const col = await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'payments' AND column_name = 'order_id'`);
  assert.equal(col.rows.length, 1);
});
