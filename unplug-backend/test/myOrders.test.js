// My Orders (spec §4), reading §10.4's checkout fields back after the fact.
//
// The endpoints already existed; what was missing was that an order line said
// `ad_banner`, which is a receipt written for the database rather than for the
// person who paid. What these protect:
//
//   1. AN ORDER IS ONLY EVER THE MEMBER'S OWN. This is money. Someone else's
//      order shows what they bought, what they paid and their reference.
//   2. EVERY PAYABLE SERVICE HAS A NAME. A new linked_type with no wording
//      would put a raw database key on somebody's order.
//   3. THE TOTALS ARE THE STORED ONES. An order is a record of what was
//      charged; recomputing it in the browser is how a display drifts from
//      what was actually taken.
//   4. CREDIT AND VOUCHERS SURVIVE. §10.4 lists them as their own lines, and
//      they are the difference between subtotal and total.

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
let server;
let baseUrl;
let tokenMine;
let tokenOther;
let myOrderId;
let theirOrderId;
// Loaded in before(), after DATABASE_URL is set — see mySubmissions.test.js.
let ref;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-myorders-'));
const port = 51200 + (process.pid % 300);
const ME = 960001;
const OTHER = 960002;

async function api(urlPath, tok) {
  const res = await fetch(baseUrl + urlPath, {
    headers: tok ? { Authorization: 'Bearer ' + tok } : {},
  });
  return { status: res.status, body: await res.json().catch(() => null) };
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

  process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${port}/unplug_test`;
  process.env.JWT_SECRET = 'test-secret-my-orders';
  process.env.UNPLUG_DISABLE_RATE_LIMITS = '1';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(dir, f), 'utf8'));
  }

  ref = require('../src/utils/submissionReference');

  const jwt = require('jsonwebtoken');
  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/orders', require('../src/routes/orders'));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await pool.query(
    `INSERT INTO users (id, email, full_name, password_hash, role)
     VALUES ($1,'me@ord.test','Me','x','member'), ($2,'other@ord.test','Other','x','member')`,
    [ME, OTHER]);
  tokenMine = jwt.sign({ id: ME, email: 'me@ord.test', role: 'member' }, process.env.JWT_SECRET);
  tokenOther = jwt.sign({ id: OTHER, email: 'other@ord.test', role: 'member' }, process.env.JWT_SECRET);

  // My order: two services, a voucher and credit applied — §10.4's shape.
  const mine = await pool.query(
    `INSERT INTO orders (user_id, reference, method, status, subtotal,
                         voucher_code, voucher_discount, credit_used, total,
                         terms_version, terms_accepted_at, info_confirmed_at)
     VALUES ($1,'UNP-MINE-1','eft','confirmed', 545.00,
             'WELCOME10', 45.00, 100.00, 400.00,
             'v1', now(), now())
     RETURNING id`, [ME]);
  myOrderId = mine.rows[0].id;
  await pool.query(
    `INSERT INTO payments (user_id, linked_type, linked_id, amount, status, method,
                           gateway_reference, order_id)
     VALUES ($1,'article_publish',1, 95.00,'confirmed','eft','GW-MINE-A',$2),
            ($1,'ad_banner',2, 450.00,'confirmed','eft','GW-MINE-B',$2)`, [ME, myOrderId]);

  const theirs = await pool.query(
    `INSERT INTO orders (user_id, reference, method, status, subtotal, total,
                         terms_version, terms_accepted_at, info_confirmed_at)
     VALUES ($1,'UNP-THEIRS-1','eft','confirmed', 95.00, 95.00, 'v1', now(), now())
     RETURNING id`, [OTHER]);
  theirOrderId = theirs.rows[0].id;
  await pool.query(
    `INSERT INTO payments (user_id, linked_type, linked_id, amount, status, method,
                           gateway_reference, order_id)
     VALUES ($1,'article_publish',3, 95.00,'confirmed','eft','GW-THEIRS',$2)`, [OTHER, theirOrderId]);
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
});

// --------------------------------------------------------------- ownership

test('A MEMBER SEES ONLY THEIR OWN ORDERS', async () => {
  const res = await api('/orders/mine', tokenMine);
  assert.equal(res.status, 200);
  const refs = res.body.orders.map((o) => o.reference);
  assert.ok(refs.includes('UNP-MINE-1'));
  assert.ok(!refs.includes('UNP-THEIRS-1'), 'another member\'s order must not appear');
});

test('AND CANNOT OPEN SOMEONE ELSE\'S BY ID', async () => {
  // This is the one that matters: an order shows what was bought, what was
  // paid, and the reference used to pay it.
  const res = await api(`/orders/${theirOrderId}`, tokenMine);
  assert.equal(res.status, 403);
});

test('signed out sees nothing', async () => {
  assert.equal((await api('/orders/mine', null)).status, 401);
  assert.equal((await api(`/orders/${myOrderId}`, null)).status, 401);
});

// ------------------------------------------------------------- the names

test('EVERY PAYABLE SERVICE HAS A MEMBER-FACING NAME', () => {
  // A linked_type with no wording would put a raw database key on an order.
  // The module throws at load if one is missing; this states it as a test so
  // the reason is visible rather than only enforced.
  const missing = Object.keys(ref.SUBMISSION_TABLE)
    .filter((t) => !Object.prototype.hasOwnProperty.call(ref.SERVICE_LABEL, t));
  assert.deepEqual(missing, [], `unnamed linked_types: ${missing.join(', ')}`);
});

test('an order line is named, not keyed', async () => {
  const res = await api(`/orders/${myOrderId}`, tokenMine);
  assert.equal(res.status, 200);
  const names = res.body.items.map((i) => i.serviceName);
  assert.deepEqual(names.sort(), ['Advert', 'Article']);
  assert.ok(!names.some((n) => n.includes('_')),
    'a name with an underscore is a database key that escaped');
});

test('the list says what each order was for, without a second request', async () => {
  const res = await api('/orders/mine', tokenMine);
  const order = res.body.orders.find((o) => o.reference === 'UNP-MINE-1');
  assert.deepEqual([...order.serviceNames].sort(), ['Advert', 'Article']);
  assert.equal(order.item_count, 2);
});

test('an unknown linked_type is shown as itself, never hidden', () => {
  // A line the member paid for must always appear, even if it is named badly.
  assert.equal(ref.serviceLabel('something_new'), 'something_new');
  assert.equal(ref.serviceLabel(null), '');
});

// -------------------------------------------------------------- the money

test('THE TOTALS ARE THE STORED ONES', async () => {
  // An order is a record of what was charged. §10.4 lists subtotal, credit and
  // total as separate lines because they are separate facts.
  const res = await api(`/orders/${myOrderId}`, tokenMine);
  const o = res.body.order;
  assert.equal(Number(o.subtotal), 545);
  assert.equal(Number(o.voucher_discount), 45);
  assert.equal(Number(o.credit_used), 100);
  assert.equal(Number(o.total), 400);
  assert.equal(o.reference, 'UNP-MINE-1');
  assert.equal(o.method, 'eft');
});

test('and they still add up', async () => {
  // Not a rule the code enforces — a check that the record is coherent, so a
  // member reading it is not left doing arithmetic that does not work.
  const res = await api(`/orders/${myOrderId}`, tokenMine);
  const o = res.body.order;
  assert.equal(
    Number(o.subtotal) - Number(o.voucher_discount) - Number(o.credit_used),
    Number(o.total),
    'subtotal less voucher less credit should be the total'
  );
});

test('an order with no payments yet still lists, with no service names', async () => {
  // The LEFT JOIN produces a NULL that must not become a blank line.
  await pool.query(
    `INSERT INTO orders (user_id, reference, method, status, subtotal, total,
                         terms_version, terms_accepted_at, info_confirmed_at)
     VALUES ($1,'UNP-EMPTY-1','eft','pending', 0, 0, 'v1', now(), now())`, [ME]);
  const res = await api('/orders/mine', tokenMine);
  const empty = res.body.orders.find((o) => o.reference === 'UNP-EMPTY-1');
  assert.ok(empty, 'the order should still be listed');
  assert.deepEqual(empty.serviceNames, []);
  assert.equal(empty.item_count, 0);
});

test('orders are newest first', async () => {
  const res = await api('/orders/mine', tokenMine);
  const dates = res.body.orders.map((o) => new Date(o.created_at).getTime());
  assert.deepEqual(dates, [...dates].sort((a, b) => b - a));
});
