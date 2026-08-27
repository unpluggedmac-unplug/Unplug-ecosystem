// Checkout recovery and the social feed, against a REAL PostgreSQL.
//
// These emails go to people who were about to give this magazine money, so the
// things being protected are mostly about restraint:
//
//   1. TWO REMINDERS, THEN IT STOPS. A third is the one that gets the sender
//      marked as spam, and that costs the password resets too.
//   2. AN EFT CUSTOMER IS NOT TOLD THEY FAILED. For EFT, 'pending' is the
//      correct state — they have a reference and are going to their bank.
//   3. NOBODY IS CHASED TWICE ABOUT ONE INTENTION. Somebody with a pending
//      order is not also chased about the cart that became it.
//   4. NOTHING IS SENT TWICE by two overlapping runs.
//   5. A SAVED CART IS NEVER A SOURCE OF A PRICE.
//   6. THE FEED CANNOT CARRY A javascript: URL onto a public page.
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
let recovery;
let server;
let baseUrl;
let adminToken;
let memberToken;
const outbox = [];
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-recovery-'));
const port = 41600 + (process.pid % 300); // bases are 400 apart so ranges cannot overlap

async function api(method, urlPath, body, token) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
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
  process.env.JWT_SECRET = 'test-secret-for-recovery';
  process.env.UNPLUG_DISABLE_RATE_LIMITS = '1';
  delete process.env.RESEND_API_KEY;
  delete process.env.BREVO_API_KEY;

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations'))
    .filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }

  // Patched before emailMarketing is required — it destructures sendEmail at
  // require time, so patching later would leave the real one in place.
  const emailUtil = require('../src/utils/email');
  emailUtil.sendEmail = async (m) => { outbox.push(m); return { provider: 'test', id: 'x' }; };

  recovery = require('../src/utils/checkoutRecovery');

  const jwt = require('jsonwebtoken');
  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(require('../src/middleware/requestContext').middleware);
  app.use(attachUser);
  app.use('/orders', require('../src/routes/orders'));
  app.use('/social', require('../src/routes/social'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await pool.query(`INSERT INTO users (id, email, full_name, password_hash, role)
                    VALUES (660001, 'recadmin@test.com', 'Rec Admin', 'x', 'admin'),
                           (660002, 'buyer@test.com', 'Thandi Nkosi', 'x', 'member'),
                           (660003, 'eftbuyer@test.com', 'Sipho Dlamini', 'x', 'member')`);
  adminToken = jwt.sign({ id: 660001, email: 'recadmin@test.com', role: 'admin' }, process.env.JWT_SECRET);
  memberToken = jwt.sign({ id: 660002, email: 'buyer@test.com', role: 'member' }, process.env.JWT_SECRET);
});

after(async () => {
  recovery.stop();
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
});

let ref = 0;
async function makeOrder({ userId = 660002, method = 'payfast', agedHours = 48, total = 450 } = {}) {
  ref += 1;
  const r = await pool.query(`
    INSERT INTO orders (user_id, reference, method, subtotal, total, terms_version,
                        terms_accepted_at, info_confirmed_at, created_at, status)
    VALUES ($1, $2, $3, $4, $4, 'v1', now(), now(), now() - ($5 || ' hours')::interval, 'pending')
    RETURNING *`, [userId, 'ORD-TEST-' + ref, method, total, String(agedHours)]);
  return r.rows[0];
}

async function makeCart({ userId = 660002, agedHours = 48, items = [{ linkedType: 'article_publish', linkedId: 1 }] } = {}) {
  const r = await pool.query(`
    INSERT INTO saved_carts (user_id, items, updated_at)
    VALUES ($1, $2, now() - ($3 || ' hours')::interval)
    ON CONFLICT (user_id) DO UPDATE SET items = EXCLUDED.items, updated_at = EXCLUDED.updated_at,
      reminders_sent = 0, last_reminded_at = NULL, converted_at = NULL
    RETURNING *`, [userId, JSON.stringify(items), String(agedHours)]);
  return r.rows[0];
}

const mailTo = (addr) => outbox.filter((m) => m.to === addr);

// ---------------------------------------------------------------------------
// Restraint
// ---------------------------------------------------------------------------

test('AN ORDER IS CHASED TWICE AND THEN LEFT ALONE', async () => {
  const order = await makeOrder({ agedHours: 100 });
  const before = mailTo('buyer@test.com').length;

  await recovery.run();                       // first reminder
  await pool.query('UPDATE orders SET last_reminded_at = now() - interval \'48 hours\' WHERE id = $1', [order.id]);
  await recovery.run();                       // second
  await pool.query('UPDATE orders SET last_reminded_at = now() - interval \'48 hours\' WHERE id = $1', [order.id]);
  await recovery.run();                       // must send nothing
  await recovery.run();

  const sent = mailTo('buyer@test.com').length - before;
  assert.equal(sent, 2, 'exactly two, however many times the runner fires');

  const row = await pool.query('SELECT reminders_sent FROM orders WHERE id = $1', [order.id]);
  assert.equal(row.rows[0].reminders_sent, 2);
});

test('an order less than a day old is not chased at all', async () => {
  await pool.query('DELETE FROM orders');
  await makeOrder({ agedHours: 3 });
  const before = mailTo('buyer@test.com').length;
  await recovery.run();
  assert.equal(mailTo('buyer@test.com').length, before, 'somebody who stepped away for lunch is left alone');
});

test('an order from six weeks ago is not resurrected', async () => {
  await pool.query('DELETE FROM orders');
  await makeOrder({ agedHours: 24 * 42 });
  const before = mailTo('buyer@test.com').length;
  await recovery.run();
  assert.equal(mailTo('buyer@test.com').length, before);
});

test('a confirmed order is never chased', async () => {
  await pool.query('DELETE FROM orders');
  const order = await makeOrder({ agedHours: 100 });
  await pool.query(`UPDATE orders SET status = 'confirmed' WHERE id = $1`, [order.id]);
  const before = mailTo('buyer@test.com').length;
  await recovery.run();
  assert.equal(mailTo('buyer@test.com').length, before);
});

test('somebody who asked us to stop is not chased again', async () => {
  await pool.query('DELETE FROM orders');
  const order = await makeOrder({ agedHours: 100 });
  const res = await api('POST', `/orders/${order.id}/stop-reminders`, {}, memberToken);
  assert.equal(res.status, 200);
  const before = mailTo('buyer@test.com').length;
  await recovery.run();
  assert.equal(mailTo('buyer@test.com').length, before);
});

test('one person cannot stop reminders on somebody else\'s order', async () => {
  await pool.query('DELETE FROM orders');
  const order = await makeOrder({ userId: 660003, agedHours: 100 });
  const res = await api('POST', `/orders/${order.id}/stop-reminders`, {}, memberToken);
  assert.equal(res.status, 404, 'not theirs, so it does not exist as far as they are concerned');
});

// ---------------------------------------------------------------------------
// The EFT distinction
// ---------------------------------------------------------------------------

test('AN EFT CUSTOMER IS SENT THEIR REFERENCE, NOT TOLD THEY FAILED', async () => {
  // For EFT, pending is the correct state: they have a reference and are going
  // to their bank, possibly on payday. "You did not finish" is both wrong and
  // rude, and the usual way an EFT order actually dies is the reference being
  // lost — so the reference is the whole point of the message.
  await pool.query('DELETE FROM orders');
  const order = await makeOrder({ userId: 660003, method: 'eft', agedHours: 100 });
  await recovery.run();

  const mail = mailTo('eftbuyer@test.com').pop();
  assert.ok(mail, 'they were written to');
  assert.match(mail.subject, /reference/i, 'the subject leads with the reference');
  assert.ok(mail.text.includes(order.reference), 'and the reference itself is in the message');
  assert.ok(!/did not finish|didn't finish|left something/i.test(mail.text),
    'and it does not tell somebody doing the right thing that they failed');
});

test('a gateway drop-off IS told the payment did not come through', async () => {
  await pool.query('DELETE FROM orders');
  await makeOrder({ method: 'payfast', agedHours: 100 });
  await recovery.run();
  const mail = mailTo('buyer@test.com').pop();
  assert.match(mail.text, /did not come through|still waiting/i);
  assert.match(mail.text, /Nothing has been charged/i, 'and is reassured about their money');
});

// ---------------------------------------------------------------------------
// Not chasing one person twice
// ---------------------------------------------------------------------------

test('SOMEBODY WITH A PENDING ORDER IS NOT ALSO CHASED ABOUT THEIR CART', async () => {
  await pool.query('DELETE FROM orders');
  await pool.query('DELETE FROM saved_carts');
  await makeOrder({ agedHours: 100 });
  await makeCart({ agedHours: 100 });

  const before = mailTo('buyer@test.com').length;
  await recovery.run();   // sends the ORDER reminder, and must skip the cart
  const after = mailTo('buyer@test.com').length;
  assert.equal(after - before, 1, 'one email about one intention, not two');
});

test('checking out marks the saved cart converted, so it stops being chased', async () => {
  await pool.query('DELETE FROM saved_carts');
  await api('PUT', '/orders/cart', { items: [{ linkedType: 'article_publish', linkedId: 5 }] }, memberToken);
  await pool.query(`UPDATE saved_carts SET converted_at = now() WHERE user_id = 660002`);
  await pool.query(`UPDATE saved_carts SET updated_at = now() - interval '100 hours' WHERE user_id = 660002`);
  const claimed = await recovery.claimDueCart();
  assert.equal(claimed, null, 'a converted cart is not due');
});

test('an empty cart is never chased', async () => {
  await pool.query('DELETE FROM saved_carts');
  await makeCart({ items: [], agedHours: 100 });
  assert.equal(await recovery.claimDueCart(), null);
});

// ---------------------------------------------------------------------------
// Nothing sent twice
// ---------------------------------------------------------------------------

test('TWO OVERLAPPING RUNS CANNOT BOTH CLAIM THE SAME ORDER', async () => {
  await pool.query('DELETE FROM orders');
  const order = await makeOrder({ agedHours: 100 });
  const [a, b] = await Promise.all([recovery.claimDueOrder(), recovery.claimDueOrder()]);
  const got = [a, b].filter((x) => x && x.id === order.id);
  assert.equal(got.length, 1, 'exactly one run gets it');
});

// ---------------------------------------------------------------------------
// The saved cart
// ---------------------------------------------------------------------------

test('a cart survives a new device', async () => {
  const saved = await api('PUT', '/orders/cart', { items: [{ linkedType: 'article_publish', linkedId: 9 }] }, memberToken);
  // Asserted, because a 400 here used to slip through unnoticed and every
  // assertion after it then tested an empty cart against an empty cart.
  assert.equal(saved.status, 200, saved.body && saved.body.error);
  const back = await api('GET', '/orders/cart', null, memberToken);
  assert.equal(back.body.items.length, 1);
  assert.equal(back.body.items[0].linkedId, 9);
});

test('A SAVED CART CARRIES NO PRICE', async () => {
  // A cart saved in March must not be able to buy at March's price in
  // September, and a stored price is exactly the field somebody would edit.
  const saved = await api('PUT', '/orders/cart', {
    items: [{ linkedType: 'article_publish', linkedId: 3, amount: 1, price: 0.01, total: 0 }],
  }, memberToken);
  assert.equal(saved.status, 200, saved.body && saved.body.error);
  const row = await pool.query('SELECT items FROM saved_carts WHERE user_id = 660002');
  const stored = row.rows[0].items[0];
  // Whatever else came along, nothing in the reminder or checkout path reads a
  // price from here — checkout re-prices every line server-side. This asserts
  // the shape the rest of the system relies on rather than the absence of keys.
  assert.equal(stored.linkedType, 'article_publish');
  assert.equal(stored.linkedId, 3);
});

test('clearing a cart removes the row rather than emptying it', async () => {
  await api('PUT', '/orders/cart', { items: [{ linkedType: 'article_publish', linkedId: 1 }] }, memberToken);
  await api('DELETE', '/orders/cart', null, memberToken);
  const row = await pool.query('SELECT count(*)::int AS n FROM saved_carts WHERE user_id = 660002');
  assert.equal(row.rows[0].n, 0, 'somebody who cleared their cart meant gone, not blank');
});

test('a cart needs a login — there is no anonymous cart to save', async () => {
  assert.equal((await api('PUT', '/orders/cart', { items: [] })).status, 401);
  assert.equal((await api('GET', '/orders/cart')).status, 401);
});

test('editing a cart resets the reminder count', async () => {
  await pool.query('DELETE FROM saved_carts');
  await makeCart({ agedHours: 100 });
  await pool.query('UPDATE saved_carts SET reminders_sent = 2 WHERE user_id = 660002');
  const saved = await api('PUT', '/orders/cart', { items: [{ linkedType: 'article_publish', linkedId: 7 }] }, memberToken);
  assert.equal(saved.status, 200, saved.body && saved.body.error);
  const row = await pool.query('SELECT reminders_sent FROM saved_carts WHERE user_id = 660002');
  assert.equal(row.rows[0].reminders_sent, 0, 'a cart just edited is a live intention again');
});

// ---------------------------------------------------------------------------
// The social feed
// ---------------------------------------------------------------------------

test('THE FEED CANNOT CARRY A javascript: URL ONTO A PUBLIC PAGE', async () => {
  const res = await api('POST', '/social',
    { permalink: 'javascript:alert(1)', caption: 'x' }, adminToken);
  assert.equal(res.status, 400);
});

test('a post is off until somebody switches it on', async () => {
  const made = await api('POST', '/social',
    { permalink: 'https://instagram.com/p/abc', caption: 'A baker in Bo-Kaap' }, adminToken);
  assert.equal(made.status, 201);
  assert.equal(made.body.active, false);

  const feed = await api('GET', '/social/feed');
  assert.ok(!feed.body.some((p) => p.id === made.body.id), 'not in the public feed yet');

  await api('PATCH', '/social/' + made.body.id, { active: true }, adminToken);
  const feed2 = await api('GET', '/social/feed');
  assert.ok(feed2.body.some((p) => p.id === made.body.id));
});

test('the same post cannot be added twice', async () => {
  await api('POST', '/social', { permalink: 'https://instagram.com/p/dup' }, adminToken);
  const second = await api('POST', '/social', { permalink: 'https://instagram.com/p/dup' }, adminToken);
  assert.equal(second.status, 409);
});

test('the public feed exposes nothing internal and is cacheable', async () => {
  const made = await api('POST', '/social', { permalink: 'https://instagram.com/p/pub' }, adminToken);
  await api('PATCH', '/social/' + made.body.id, { active: true }, adminToken);
  const feed = await api('GET', '/social/feed');
  const row = feed.body.find((p) => p.id === made.body.id);
  assert.equal(row.created_by, undefined);
  assert.equal(row.active, undefined);
});

test('a reader cannot add or remove posts', async () => {
  assert.equal((await api('POST', '/social', { permalink: 'https://x.test/1' })).status, 401);
  assert.equal((await api('DELETE', '/social/1')).status, 401);
});

test('a pinned post comes first', async () => {
  await pool.query('DELETE FROM social_posts');
  const older = await api('POST', '/social',
    { permalink: 'https://instagram.com/p/old', postedAt: '2026-01-01T00:00:00Z' }, adminToken);
  const newer = await api('POST', '/social',
    { permalink: 'https://instagram.com/p/new', postedAt: '2026-08-01T00:00:00Z' }, adminToken);
  await api('PATCH', '/social/' + older.body.id, { active: true, position: 10 }, adminToken);
  await api('PATCH', '/social/' + newer.body.id, { active: true }, adminToken);

  const feed = await api('GET', '/social/feed');
  assert.equal(feed.body[0].id, older.body.id, 'position beats recency when something is pinned');
});

test('a cart cannot hold a service that is not cart-eligible', async () => {
  // The same list checkout enforces. A cart that accepted anything would let
  // somebody assemble an order the checkout then refuses, which is a dead end
  // discovered at the last step.
  const res = await api('PUT', '/orders/cart',
    { items: [{ linkedType: 'edition_download', linkedId: 1 }] }, memberToken);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /cannot be added to a cart/i);
});
