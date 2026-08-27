// Reading and editing a submission BEFORE approving it.
//
// The bug this fixes: the queue only ever returned a summary — an article's
// title, who sent it, what was paid. Not the body. So an admin approving from
// the queue was deciding on a headline alone, and found out what they had
// published by reading the live site afterwards.
//
// What these tests protect:
//
//   1. THE ADMIN CAN ACTUALLY SEE IT. The detail endpoint returns the whole
//      record, including the body.
//   2. MONEY IS NOT EDITABLE. amount, price, order totals, payment status and
//      gateway references record what happened at a payment gateway. An
//      editable amount is how the books stop matching the bank.
//   3. STATUS IS NOT EDITABLE. Approving is what the approve action is for. A
//      status writable from two places ends up disagreeing with itself.
//   4. A COLUMN NOT ON THE WHITELIST NEVER REACHES SQL. The table and column
//      names are constants in the route; nothing in the request can name one.
//   5. EDITING DOES NOT APPROVE. They are two acts.
//   6. IT IS ADMIN-ONLY.
//
// Run with:  npm test   (from unplug-backend/)

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
let memberToken;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-aqedit-'));
const port = 44800 + (process.pid % 300); // bases are 400 apart so ranges cannot overlap

const migrationsDir = path.join(__dirname, '..', 'db', 'migrations');
async function runMigrations() {
  for (const f of fs.readdirSync(migrationsDir).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(migrationsDir, f), 'utf8'));
  }
}

async function api(method, urlPath, body, token) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const ART = 9401;
const BODY = 'The original body, which an admin could never see before approving it.';

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
  process.env.JWT_SECRET = 'test-secret-for-aqedit';
  process.env.UNPLUG_DISABLE_RATE_LIMITS = '1';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await runMigrations();

  const jwt = require('jsonwebtoken');
  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/admin/approval-queue', require('../src/routes/adminApprovalQueue'));
  app.use('/', require('../src/routes/profiles'));   // exposes /profiles/:slug
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await pool.query(`INSERT INTO users (id, email, full_name, password_hash, role) VALUES
    (600001, 'aqadmin@test.com', 'AQ Admin', 'x', 'admin'),
    (600002, 'aqmember@test.com', 'AQ Member', 'x', 'member'),
    (600003, 'aqother@test.com', 'AQ Other', 'x', 'member')`);
  adminToken = jwt.sign({ id: 600001, email: 'aqadmin@test.com', role: 'admin' }, process.env.JWT_SECRET);
  memberToken = jwt.sign({ id: 600002, email: 'aqmember@test.com', role: 'member' }, process.env.JWT_SECRET);

  await pool.query(`INSERT INTO categories (id, name, type) VALUES (9401, 'News', 'news')
                    ON CONFLICT (id) DO NOTHING`);
  await pool.query(
    `INSERT INTO articles (id, author_user_id, category_id, title, body, status)
     VALUES ($1, 600002, 9401, 'A Pending Story', $2, 'pending')`, [ART, BODY]);

  await pool.query(
    `INSERT INTO profiles (id, user_id, type, category_id, package_tier, slug, display_name, bio, status)
     VALUES (9461, 600002, 'business', 9401, 'basic', 'pending-listing', 'Pending Listing',
             'SECRETBIO not for the public yet.', 'pending'),
            (9462, 600003, 'business', 9401, 'basic', 'live-listing', 'Live Listing',
             'Already approved.', 'approved')`);
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
});

// ----------------------------------------------------------------- reading

test('THE ADMIN CAN ACTUALLY SEE THE SUBMISSION', async () => {
  const { status, body } = await api('GET', `/admin/approval-queue/article/${ART}`, null, adminToken);
  assert.equal(status, 200);
  assert.equal(body.item.title, 'A Pending Story');
  assert.equal(body.item.body, BODY, 'the body is there — this is the whole bug');
  assert.ok(body.fields.length, 'and it says what may be edited');
  assert.equal(body.editable, true);
});

test('it says where the item can be previewed', async () => {
  const { body } = await api('GET', `/admin/approval-queue/article/${ART}`, null, adminToken);
  assert.match(body.previewUrl, /\?p=article&id=/);
});

test('a type with no public page of its own says so, rather than guessing', async () => {
  // A cart order has no page a reader could ever visit. Null beats a button
  // that opens the homepage and looks broken.
  await pool.query(`INSERT INTO orders (id, user_id, reference, method, status, subtotal, total,
                                       terms_version, terms_accepted_at, info_confirmed_at)
                    VALUES (9411, 600002, 'REF-1', 'eft', 'pending', 100, 100, '2026.07.29', now(), now())`);
  const { body } = await api('GET', '/admin/approval-queue/cart_order/9411', null, adminToken);
  assert.equal(body.previewUrl, null);
  assert.equal(body.editable, false, 'and nothing on it is editable');
});

test('an unknown type is a 404, not a crash', async () => {
  const { status } = await api('GET', '/admin/approval-queue/not_a_type/1', null, adminToken);
  assert.equal(status, 404);
});

// ----------------------------------------------------------------- editing

test('an admin can correct a submission before approving it', async () => {
  const { status, body } = await api('PATCH', `/admin/approval-queue/article/${ART}`,
    { fields: { title: 'A Corrected Story', body: 'Tidied up.' } }, adminToken);
  assert.equal(status, 200);
  assert.equal(body.item.title, 'A Corrected Story');
  assert.equal(body.item.body, 'Tidied up.');

  const row = await pool.query('SELECT title, body FROM articles WHERE id = $1', [ART]);
  assert.equal(row.rows[0].title, 'A Corrected Story', 'and it is actually saved');
});

test('EDITING DOES NOT APPROVE', async () => {
  const row = await pool.query('SELECT status FROM articles WHERE id = $1', [ART]);
  assert.equal(row.rows[0].status, 'pending',
    'editing and deciding are two acts — a save that published would mean never being able to fix a typo without committing');
});

test('STATUS IS NOT EDITABLE THROUGH THIS ROUTE', async () => {
  await api('PATCH', `/admin/approval-queue/article/${ART}`,
    { fields: { status: 'approved' } }, adminToken);
  const row = await pool.query('SELECT status FROM articles WHERE id = $1', [ART]);
  assert.equal(row.rows[0].status, 'pending', 'a status writable from two places ends up disagreeing with itself');
});

test('A COLUMN NOT ON THE WHITELIST NEVER REACHES SQL', async () => {
  // Including one that does not exist at all: if it were interpolated, this
  // would be a 500 from Postgres rather than a clean refusal.
  const { status, body } = await api('PATCH', `/admin/approval-queue/article/${ART}`,
    { fields: { author_user_id: 600001, no_such_column: 'x', 'body"; DROP TABLE articles; --': 'y' } },
    adminToken);
  assert.equal(status, 400);
  assert.match(body.error, /no editable fields/i);

  const still = await pool.query('SELECT author_user_id FROM articles WHERE id = $1', [ART]);
  assert.equal(still.rows[0].author_user_id, 600002, 'ownership unchanged');
  const table = await pool.query(`SELECT to_regclass('public.articles') AS t`);
  assert.ok(table.rows[0].t, 'and the table is very much still there');
});

test('a bad date is refused with a readable message', async () => {
  await pool.query(`INSERT INTO shoutout_nominations (id, nominee_name, message, status)
                    VALUES (9421, 'Someone', 'A message', 'pending')`);
  const { status, body } = await api('PATCH', '/admin/approval-queue/shoutout/9421',
    { fields: { available_from: 'next Tuesday-ish' } }, adminToken);
  assert.equal(status, 400);
  assert.match(body.error, /date/i);
});

test('clearing a field is allowed and stores null, not an empty string', async () => {
  await api('PATCH', `/admin/approval-queue/article/${ART}`, { fields: { subtitle: 'Something' } }, adminToken);
  await api('PATCH', `/admin/approval-queue/article/${ART}`, { fields: { subtitle: '   ' } }, adminToken);
  const row = await pool.query('SELECT subtitle FROM articles WHERE id = $1', [ART]);
  assert.equal(row.rows[0].subtitle, null);
});

// ------------------------------------------------------------------- money

test('MONEY IS NOT EDITABLE — an order total cannot be rewritten', async () => {
  const before = await pool.query('SELECT total, status FROM orders WHERE id = 9411');
  const { status } = await api('PATCH', '/admin/approval-queue/cart_order/9411',
    { fields: { total: 1, subtotal: 1, status: 'confirmed' } }, adminToken);
  assert.equal(status, 400, 'there is nothing editable on an order at all');
  const after = await pool.query('SELECT total, status FROM orders WHERE id = 9411');
  assert.deepEqual(after.rows[0], before.rows[0], 'the money and the status are untouched');
});

test('nor a payment amount or its gateway reference', async () => {
  await pool.query(`INSERT INTO payments (id, user_id, amount, method, gateway_reference, status, linked_type, linked_id)
                    VALUES (9431, 600002, 250.00, 'eft', 'GW-REF-9431', 'pending', 'article_publish', $1)`, [ART]);
  const { status } = await api('PATCH', '/admin/approval-queue/service_payment/9431',
    { fields: { amount: 1, gateway_reference: 'GW-FAKE', status: 'confirmed' } }, adminToken);
  assert.equal(status, 400);
  const row = await pool.query('SELECT amount, gateway_reference, status FROM payments WHERE id = 9431');
  assert.equal(Number(row.rows[0].amount), 250);
  assert.equal(row.rows[0].gateway_reference, 'GW-REF-9431');
  assert.equal(row.rows[0].status, 'pending');
});

test('but the descriptive part of a purchase IS editable', async () => {
  // A misspelled customer name on an edition purchase is a typo, not a
  // financial record.
  await pool.query(`INSERT INTO editions (id, issue_number, title, pdf_url)
                    VALUES (9441, 9441, 'An Edition', 'x.pdf')`);
  await pool.query(`INSERT INTO edition_purchases
      (id, user_id, edition_id, customer_email, customer_name, amount, payment_status)
      VALUES (9451, 600002, 9441, 'buyer@test.com', 'Naledi Mokena', 50, 'pending_approval')`);
  const { status } = await api('PATCH', '/admin/approval-queue/edition_purchase/9451',
    { fields: { customer_name: 'Naledi Mokoena', amount: 1 } }, adminToken);
  assert.equal(status, 200);
  const row = await pool.query('SELECT customer_name, amount FROM edition_purchases WHERE id = 9451');
  assert.equal(row.rows[0].customer_name, 'Naledi Mokoena', 'the typo is fixed');
  assert.equal(Number(row.rows[0].amount), 50, 'and the amount was ignored, not applied');
});

// ------------------------------------------------------------------ access

test('IT IS ADMIN-ONLY', async () => {
  assert.equal((await api('GET', `/admin/approval-queue/article/${ART}`, null, memberToken)).status, 403);
  assert.equal((await api('GET', `/admin/approval-queue/article/${ART}`)).status, 401);
  assert.equal((await api('PATCH', `/admin/approval-queue/article/${ART}`,
    { fields: { title: 'hacked' } }, memberToken)).status, 403);
  const row = await pool.query('SELECT title FROM articles WHERE id = $1', [ART]);
  assert.notEqual(row.rows[0].title, 'hacked');
});

test('the edit is written to the audit trail', async () => {
  await api('PATCH', `/admin/approval-queue/article/${ART}`, { fields: { title: 'Audited' } }, adminToken);
  const log = await pool.query(
    `SELECT action, details FROM admin_activity_log WHERE action = 'submission_edited' ORDER BY id DESC LIMIT 1`);
  assert.ok(log.rows.length, 'an admin changing somebody else\'s submission is exactly what an audit trail is for');
  assert.match(log.rows[0].details, /Article #/);
});

test('every declared type points at a real table with real columns', async () => {
  // Guards the whole descriptor table in one go: a typo in a column name would
  // otherwise only surface as a 500 the first time an admin opened that type.
  const { DETAILS } = require('../src/routes/adminApprovalQueue');
  for (const [type, d] of Object.entries(DETAILS)) {
    const cols = (await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
      [d.table])).rows.map((r) => r.column_name);
    assert.ok(cols.length, `${type}: table ${d.table} does not exist`);
    for (const fld of d.fields) {
      assert.ok(cols.includes(fld.col), `${type}: ${d.table} has no column ${fld.col}`);
    }
  }
});


// ------------------------------------- previewing a pending item as the public

test('A PENDING LISTING IS NOT VISIBLE TO THE PUBLIC', async () => {
  // The whole point of the admin exception below is that it is an EXCEPTION.
  const anon = await api('GET', '/profiles/pending-listing');
  assert.equal(anon.status, 404, 'signed out: not found');
  const member = await api('GET', '/profiles/pending-listing', null, memberToken);
  assert.equal(member.status, 404, 'an ordinary member: not found');
  assert.equal(JSON.stringify(anon.body).indexOf('SECRETBIO'), -1);
});

test('BUT AN ADMIN CAN OPEN IT, so the queue can show the real page', async () => {
  const { status, body } = await api('GET', '/profiles/pending-listing', null, adminToken);
  assert.equal(status, 200);
  assert.equal(body.profile.display_name, 'Pending Listing');
  assert.match(body.profile.bio, /SECRETBIO/);
});

test('an approved listing is still public to everyone', async () => {
  const anon = await api('GET', '/profiles/live-listing');
  assert.equal(anon.status, 200, 'the exception did not break the normal path');
  assert.equal(anon.body.profile.display_name, 'Live Listing');
});

test('the admin exception is driven by the token, not by anything in the request', async () => {
  // A forged "I am an admin" in the query string or body must do nothing.
  const spoofQuery = await api('GET', '/profiles/pending-listing?isAdmin=true&admin=1');
  assert.equal(spoofQuery.status, 404);
  const badToken = await api('GET', '/profiles/pending-listing', null, 'not-a-real-token');
  assert.equal(badToken.status, 404, 'an unverifiable token is not an admin');
});
