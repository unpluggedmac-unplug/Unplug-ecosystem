// Declining a paid submission and crediting the member (spec §10.7).
//
// The pathway already existed: POST /admin/content/:resource/:id/decline-with-credit
// finds the confirmed payment, refuses a second credit, writes account_credits
// and marks payments.credited_at, all in one transaction.
//
// What it could not do was SAY SO. It set the submission to 'rejected', the
// same value used when an admin simply refuses something, so nothing could tell
// a submission that was turned down from one that was turned down AND paid
// back. That is the difference between an editorial decision and a money one.
//
// What these protect:
//
//   1. A CREDITED DECLINE IS DISTINGUISHABLE from a plain rejection.
//   2. IT ONLY USES credit_issued WHERE THE TABLE ACCEPTS IT. The status
//      exists on migrated services only; writing it elsewhere would violate a
//      CHECK, so the vocabulary is asked rather than assumed.
//   3. THE MONEY IS RIGHT: one credit, never two, for the amount actually paid,
//      recorded against the payment, the admin and the reference.

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
let adminToken;
let SUB;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-credit-'));
const port = 47600 + (process.pid % 300); // bases are 400 apart so ranges cannot overlap

async function api(method, urlPath, body, token) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
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
  process.env.JWT_SECRET = 'test-secret-for-credit';
  process.env.UNPLUG_DISABLE_RATE_LIMITS = '1';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(dir, f), 'utf8'));
  }
  SUB = require('../src/utils/submissionStatus');

  const jwt = require('jsonwebtoken');
  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/admin/content', require('../src/routes/adminContent'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await pool.query(`INSERT INTO users (id, email, full_name, password_hash, role) VALUES
    (760001, 'admin@credit.test', 'Credit Admin', 'x', 'admin'),
    (760002, 'member@credit.test', 'Credit Member', 'x', 'member')`);
  adminToken = jwt.sign({ id: 760001, email: 'admin@credit.test', role: 'admin' }, process.env.JWT_SECRET);
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
});

// A paid article, with its payment inside a cart order so it has a reference.
async function paidArticle({ amount = 95, withOrder = true } = {}) {
  const a = await pool.query(
    `INSERT INTO articles (author_user_id, title, body, status)
     VALUES (760002, 'A paid article', 'Body text for the article.', 'pending') RETURNING id`
  );
  const id = a.rows[0].id;

  let orderId = null;
  if (withOrder) {
    const o = await pool.query(
      `INSERT INTO orders (user_id, reference, method, subtotal, total,
                           terms_version, terms_accepted_at, info_confirmed_at)
       VALUES (760002, $1, 'eft', $2, $2, '2026.07.29', now(), now()) RETURNING id`,
      ['UNP-CRED' + Math.random().toString(36).slice(2, 8).toUpperCase(), amount]
    );
    orderId = o.rows[0].id;
  }
  const p = await pool.query(
    `INSERT INTO payments (user_id, gateway_reference, amount, method, linked_type, linked_id, status, order_id)
     VALUES (760002, $1, $2, 'eft', 'article_publish', $3, 'confirmed', $4) RETURNING id`,
    ['GW' + Math.random().toString(36).slice(2, 10).toUpperCase(), amount, id, orderId]
  );
  return { id, paymentId: p.rows[0].id, orderId };
}

const balance = async () => Number((await pool.query(
  'SELECT COALESCE(SUM(amount),0)::numeric AS b FROM account_credits WHERE user_id = 760002'
)).rows[0].b);

// ---------------------------------------------------------------------------

test('A CREDITED DECLINE IS NOT THE SAME AS A PLAIN REJECTION', async () => {
  // The whole point. Both used to be 'rejected', so no report could say which
  // refusals had money attached.
  const { id } = await paidArticle();
  const res = await api('POST', `/admin/content/articles/${id}/decline-with-credit`,
    { note: 'Photo rights unclear' }, adminToken);
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const row = await pool.query('SELECT status FROM articles WHERE id = $1', [id]);
  assert.equal(row.rows[0].status, 'credit_issued',
    'a declined-and-credited article must be distinguishable from a rejected one');
});

test('the credit records amount, payment, admin and reason', async () => {
  const before = await balance();
  const { id, paymentId } = await paidArticle({ amount: 95 });
  await api('POST', `/admin/content/articles/${id}/decline-with-credit`,
    { note: 'Not a fit for the section' }, adminToken);

  const c = await pool.query(
    'SELECT * FROM account_credits WHERE payment_id = $1', [paymentId]
  );
  assert.equal(c.rows.length, 1);
  assert.equal(Number(c.rows[0].amount), 95, 'credit is what was actually paid');
  assert.equal(c.rows[0].reason, 'declined_submission');
  assert.equal(c.rows[0].created_by, 760001, 'a credit is money; it is never anonymous');
  assert.match(c.rows[0].note, /Not a fit for the section/);
  assert.equal(await balance(), before + 95);
});

test('THE REFERENCE IS RECORDED, so a bank statement can be reconciled', async () => {
  // §10.7 asks for the credit to be recorded against the original reference.
  // It is reachable through payment_id, and written into the note so an admin
  // does not have to follow the link to read it.
  const { id, orderId } = await paidArticle();
  const ord = await pool.query('SELECT reference FROM orders WHERE id = $1', [orderId]);
  await api('POST', `/admin/content/articles/${id}/decline-with-credit`, {}, adminToken);

  const c = await pool.query(
    `SELECT ac.note FROM account_credits ac
       JOIN payments p ON p.id = ac.payment_id
      WHERE p.linked_id = $1 AND p.linked_type = 'article_publish'`, [id]
  );
  assert.match(c.rows[0].note, new RegExp(ord.rows[0].reference),
    'the note should name the reference the customer paid under');
});

test('a payment with no order still credits, quoting its own reference', async () => {
  // Not every purchase goes through the cart. The gateway reference is then the
  // only reference there is, and it must still be recorded.
  const { id } = await paidArticle({ withOrder: false });
  const res = await api('POST', `/admin/content/articles/${id}/decline-with-credit`, {}, adminToken);
  assert.equal(res.status, 200);
  const c = await pool.query(
    `SELECT ac.note FROM account_credits ac JOIN payments p ON p.id = ac.payment_id
      WHERE p.linked_id = $1`, [id]
  );
  assert.match(c.rows[0].note, /reference GW/);
});

test('THE SAME PAYMENT CANNOT BE CREDITED TWICE', async () => {
  // The money test. A second credit would hand the member their fee again.
  const { id } = await paidArticle();
  const first = await api('POST', `/admin/content/articles/${id}/decline-with-credit`, {}, adminToken);
  assert.equal(first.status, 200);
  const before = await balance();

  const second = await api('POST', `/admin/content/articles/${id}/decline-with-credit`, {}, adminToken);
  assert.equal(second.status, 409, 'a second credit must be refused');
  assert.equal(await balance(), before, 'and must not move the balance');
});

test('nothing is credited when nothing was paid', async () => {
  const a = await pool.query(
    `INSERT INTO articles (author_user_id, title, body, status)
     VALUES (760002, 'Never paid for', 'Body text.', 'pending') RETURNING id`
  );
  const before = await balance();
  const res = await api('POST', `/admin/content/articles/${a.rows[0].id}/decline-with-credit`, {}, adminToken);
  assert.equal(res.status, 404);
  assert.equal(await balance(), before);
  const row = await pool.query('SELECT status FROM articles WHERE id = $1', [a.rows[0].id]);
  assert.equal(row.rows[0].status, 'pending', 'and the submission is left alone');
});

test('IT ONLY WRITES credit_issued WHERE THE TABLE ACCEPTS IT', async () => {
  // Phase B migrated five services. The others still reject the value at the
  // CHECK, so the route asks the vocabulary rather than assuming. If this were
  // wrong the endpoint would throw a constraint violation instead of crediting.
  const migrated = ['articles', 'gallery_images', 'events', 'marketplace_listings', 'highlights'];
  migrated.forEach((t) => assert.ok(SUB.isLiveFor('credit_issued', t), `${t} should accept it`));
  ['profiles', 'top10_entries', 'competition_entries']
    .forEach((t) => assert.equal(SUB.isLiveFor('credit_issued', t), false,
      `${t} has not been migrated, so the route must fall back to 'rejected'`));
});

test('the decline is admin-only', async () => {
  const { id } = await paidArticle();
  const res = await api('POST', `/admin/content/articles/${id}/decline-with-credit`, {}, null);
  assert.equal(res.status, 401);
});
