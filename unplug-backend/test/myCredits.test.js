// My Credits (spec §4; the rules are §10.6 and §10.7).
//
// This is the money side of the Refund & Cancellation Policy: the site promises
// that a declined or cancelled paid submission comes back as CREDIT rather than
// cash, and this is where a member is shown that it happened. The ledger had no
// test coverage at all before this.
//
// What these protect:
//
//   1. THE BALANCE IS THE SUM OF THE LEDGER. Never a stored number. If a
//      member's balance disagrees with their own history, the site is lying to
//      them about money it owes them.
//   2. IT IS THEIRS ALONE. A credit line names a submission and a reference.
//   3. §10.7's ORIGINAL REFERENCE reaches the member. `payment_id` means
//      nothing to them; the reference is what they put on their EFT.
//   4. EVERY REASON HAS WORDING. 'declined_submission' is a column name; the
//      member is owed a sentence.
//   5. SPENDING SHOWS AS SPENDING. Negative lines must be visible, or credit
//      appears to vanish.

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
let credit;      // required in before(), after DATABASE_URL is set
let myPaymentId;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-mycredits-'));
const port = 51600 + (process.pid % 300);
const ME = 970101;
const OTHER = 970102;
const ADMIN = 970103;

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
  process.env.JWT_SECRET = 'test-secret-my-credits';
  process.env.UNPLUG_DISABLE_RATE_LIMITS = '1';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(dir, f), 'utf8'));
  }

  credit = require('../src/utils/accountCredit');

  const jwt = require('jsonwebtoken');
  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/payments', require('../src/routes/payments'));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await pool.query(
    `INSERT INTO users (id, email, full_name, password_hash, role)
     VALUES ($1,'me@cr.test','Me','x','member'),
            ($2,'other@cr.test','Other','x','member'),
            ($3,'admin@cr.test','Admin','x','admin')`, [ME, OTHER, ADMIN]);
  tokenMine = jwt.sign({ id: ME, email: 'me@cr.test', role: 'member' }, process.env.JWT_SECRET);
  tokenOther = jwt.sign({ id: OTHER, email: 'other@cr.test', role: 'member' }, process.env.JWT_SECRET);

  // A real declined-submission credit: an order, its payment, then the credit
  // recorded against that payment — the §10.7 chain.
  const order = await pool.query(
    `INSERT INTO orders (user_id, reference, method, status, subtotal, total,
                         terms_version, terms_accepted_at, info_confirmed_at)
     VALUES ($1,'UNP-CRED-1','eft','confirmed', 95.00, 95.00,'v1', now(), now())
     RETURNING id`, [ME]);
  const payment = await pool.query(
    `INSERT INTO payments (user_id, linked_type, linked_id, amount, status, method,
                           gateway_reference, order_id)
     VALUES ($1,'article_publish',1, 95.00,'confirmed','eft','GW-CRED-1',$2)
     RETURNING id`, [ME, order.rows[0].id]);
  myPaymentId = payment.rows[0].id;

  await pool.query(
    `INSERT INTO account_credits (user_id, amount, reason, note, payment_id, created_by)
     VALUES ($1, 95.00,'declined_submission','Photo did not meet our size guide',$2,$3)`,
    [ME, myPaymentId, ADMIN]);
  await pool.query(
    `INSERT INTO account_credits (user_id, amount, reason, note, created_by)
     VALUES ($1, 50.00,'admin_adjustment','Goodwill',$2)`, [ME, ADMIN]);
  await pool.query(
    `INSERT INTO account_credits (user_id, amount, reason, note)
     VALUES ($1, -45.00,'spent_at_checkout','Used on UNP-LATER-9')`, [ME]);

  // Someone else's credit, which must never appear.
  await pool.query(
    `INSERT INTO account_credits (user_id, amount, reason, note)
     VALUES ($1, 500.00,'admin_adjustment','Not yours')`, [OTHER]);
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
});

// ----------------------------------------------------------------- balance

test('THE BALANCE IS THE SUM OF THE LEDGER', async () => {
  // 95 + 50 - 45. If the balance and the history disagree, the site is lying
  // to a member about money it owes them.
  const res = await api('/payments/credit', tokenMine);
  assert.equal(res.status, 200);
  assert.equal(Number(res.body.balance), 100);

  const summed = res.body.history.reduce((n, h) => n + Number(h.amount), 0);
  assert.equal(summed, Number(res.body.balance),
    'the history must add up to the balance shown above it');
});

test('IT IS THEIRS ALONE', async () => {
  const res = await api('/payments/credit', tokenOther);
  assert.equal(Number(res.body.balance), 500);
  const notes = res.body.history.map((h) => h.note).join(' | ');
  assert.ok(!notes.includes('Goodwill'), `another member's ledger leaked: ${notes}`);
});

test('signed out sees nothing', async () => {
  assert.equal((await api('/payments/credit', null)).status, 401);
});

test('a member with no credit gets zero and an empty ledger, not an error', async () => {
  const jwt = require('jsonwebtoken');
  await pool.query(
    `INSERT INTO users (id, email, full_name, password_hash, role)
     VALUES (970104,'none@cr.test','None','x','member')`);
  const token = jwt.sign({ id: 970104, email: 'none@cr.test', role: 'member' },
    process.env.JWT_SECRET);
  const res = await api('/payments/credit', token);
  assert.equal(res.status, 200);
  assert.equal(Number(res.body.balance), 0);
  assert.deepEqual(res.body.history, []);
});

// ------------------------------------------------- §10.7's original reference

test('A CREDIT CARRIES THE REFERENCE IT CAME FROM', async () => {
  // §10.7: the credit must be recorded against the original reference and the
  // original payment. payment_id means nothing to a member; the reference is
  // what they were shown at checkout and put on their EFT.
  const res = await api('/payments/credit', tokenMine);
  const declined = res.body.history.find((h) => h.reason === 'declined_submission');
  assert.ok(declined, 'the declined-submission credit should be there');
  assert.equal(declined.reference, 'UNP-CRED-1', 'the ORDER reference, not the gateway one');
  assert.equal(declined.payment_id, myPaymentId);
  assert.equal(declined.serviceName, 'Article', 'and what it was for, in words');
});

test('a credit with no payment behind it simply has no reference', async () => {
  // An admin adjustment is not attached to anything. It must not invent one.
  const res = await api('/payments/credit', tokenMine);
  const adj = res.body.history.find((h) => h.reason === 'admin_adjustment');
  assert.equal(adj.reference, null);
  assert.equal(adj.serviceName, null);
});

test('which admin issued it is recorded but NOT shown to the member', async () => {
  // §10.7 requires it recorded, and it is, on the row. Showing a member which
  // member of staff declined their submission is a different decision.
  const stored = await pool.query(
    `SELECT created_by FROM account_credits WHERE user_id = $1 AND reason = 'declined_submission'`,
    [ME]);
  assert.equal(stored.rows[0].created_by, ADMIN, 'it must be recorded');

  const res = await api('/payments/credit', tokenMine);
  const declined = res.body.history.find((h) => h.reason === 'declined_submission');
  assert.ok(!('created_by' in declined), 'and not returned to the member');
});

// ------------------------------------------------------------- the wording

test('EVERY REASON THE LEDGER ALLOWS HAS MEMBER-FACING WORDING', () => {
  // 'declined_submission' is a column name. A member is owed a sentence.
  const missing = credit.REASONS.filter(
    (r) => !Object.prototype.hasOwnProperty.call(credit.REASON_LABEL, r));
  assert.deepEqual(missing, []);
});

test('the wording the CHECK allows and the wording we ship are the same set', async () => {
  // If the database gains a reason and nobody words it, a member sees a raw
  // enum. Read from the constraint rather than trusting the constant.
  const r = await pool.query(
    `SELECT pg_get_constraintdef(oid) AS def
       FROM pg_constraint
      WHERE conname = 'account_credits_reason_check'`);
  assert.equal(r.rows.length, 1, 'the reason CHECK should exist');
  const inDb = [...r.rows[0].def.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(inDb, [...credit.REASONS].sort(),
    'accountCredit.REASONS has drifted from the database CHECK');
});

test('rows arrive already worded, so no section re-invents it', async () => {
  const res = await api('/payments/credit', tokenMine);
  for (const h of res.body.history) {
    assert.equal(h.reasonLabel, credit.reasonLabel(h.reason));
    assert.ok(!h.reasonLabel.includes('_'),
      `'${h.reasonLabel}' is a database key that escaped`);
  }
});

// -------------------------------------------------------------- spending

test('SPENDING SHOWS AS SPENDING', async () => {
  // Positive grants, negative spends. Hiding the negatives would make credit
  // appear to vanish between one visit and the next.
  const res = await api('/payments/credit', tokenMine);
  const spent = res.body.history.find((h) => h.reason === 'spent_at_checkout');
  assert.ok(spent, 'the spend must be visible');
  assert.ok(Number(spent.amount) < 0);
  assert.equal(spent.reasonLabel, 'Used at checkout');
});

test('the ledger reads newest first', async () => {
  const res = await api('/payments/credit', tokenMine);
  const dates = res.body.history.map((h) => new Date(h.created_at).getTime());
  assert.deepEqual(dates, [...dates].sort((a, b) => b - a));
});
