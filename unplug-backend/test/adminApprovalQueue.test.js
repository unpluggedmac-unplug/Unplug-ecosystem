// ADMIN — the single unified Approval Queue (routes/adminApprovalQueue.js).
//
// The guarantees worth testing hardest:
//   1. EVERY source query must actually run against the real schema. Seventeen
//      hand-written queries across seventeen differently-shaped tables is
//      exactly the kind of code where one wrong column name hides until an
//      admin opens the page. The router deliberately swallows a failing source
//      into `problems` so one broken table can't blank the queue — which means
//      a silent typo would otherwise never surface. So the first test asserts
//      `problems` is EMPTY, with every type requested.
//   2. One purchase must never appear as two rows. An order-linked payment has
//      to surface as its parent order and not also as a standalone payment.
//   3. Admin-added competition entries (manual_name, no profile row) must
//      appear. The old queue inner-joined profiles and silently hid every one.
//   4. A vote purchase must carry the contestant's entry code as its reference.
//   5. Admin-only.
//
// Over real HTTP against real PostgreSQL. See universalComments.test.js for
// why require('../src/app') is avoided.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-aq-'));
const port = 23200 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

async function req(method, urlPath, { token } = {}) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, body: json };
}

let jwt;
function tokenFor(userId, role = 'member') {
  return jwt.sign({ id: userId, email: `aq${userId}@test.com`, role }, process.env.JWT_SECRET);
}

let _nextUserId = 81000;
async function makeUser(role = 'member') {
  const id = _nextUserId++;
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role, full_name)
     VALUES ($1, $2, 'x', $3, $4) ON CONFLICT DO NOTHING`,
    [id, `aq${id}@test.com`, role, `Person ${id}`]
  );
  return id;
}

let _nextSlug = 0;
async function makeProfile(userId, status = 'approved') {
  const r = await pool.query(
    `INSERT INTO profiles (user_id, type, package_tier, slug, display_name, status)
     VALUES ($1, 'individual', 'basic', $2, $3, $4) RETURNING id`,
    [userId, `aq-profile-${_nextSlug++}`, `Listing ${_nextSlug}`, status]
  );
  return r.rows[0].id;
}

// Payments carry the reference code the admin matches against the bank
// statement, so most seeds need one attached to the thing they paid for.
async function makePayment(userId, linkedType, linkedId, { status = 'pending', reference, amount = 100, orderId = null } = {}) {
  const r = await pool.query(
    `INSERT INTO payments (user_id, amount, method, gateway_reference, status, linked_type, linked_id, order_id)
     VALUES ($1, $2, 'eft', $3, $4, $5, $6, $7) RETURNING id`,
    [userId, amount, reference || `AQREF${Math.random().toString(36).slice(2, 10).toUpperCase()}`, status, linkedType, linkedId, orderId]
  );
  return r.rows[0].id;
}

let adminToken;
let memberToken;

before(async () => {
  pg = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'postgres', password: 'postgres', port,
    persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('unplug_test');

  process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${port}/unplug_test`;
  process.env.JWT_SECRET = 'test-secret-for-approval-queue';
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
  app.use('/admin/approval-queue', require('../src/routes/adminApprovalQueue'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const adminId = await makeUser('admin');
  adminToken = tokenFor(adminId, 'admin');
  memberToken = tokenFor(await makeUser('member'), 'member');
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  if (pg) await pg.stop();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* Windows holds the dir briefly */ }
});

test('every source query runs against the real schema', async () => {
  const res = await req('GET', '/admin/approval-queue', { token: adminToken });
  assert.equal(res.status, 200);
  // This is the assertion that earns this file its keep: a single mistyped
  // column in any of the seventeen queries lands here as a named problem
  // instead of quietly returning an incomplete queue in production.
  assert.deepEqual(res.body.problems, [], 'a source query failed: ' + JSON.stringify(res.body.problems));

  // Every declared type must have a source that RAN. Asserting the count
  // instead used to mean this test broke every time a legitimate source was
  // added — it has been edited from 17 to 18 to 20 to 18 already, which trains
  // whoever hits it next to just bump the number rather than ask why.
  //
  // A source that silently disappeared still fails here, because its type
  // would no longer be listed and every type is checked to be reachable.
  assert.ok(res.body.types.length >= 18, 'sources have gone missing: ' + res.body.types.length);
  res.body.types.forEach((t) => {
    assert.ok(t.key && t.label && t.group, 'every type needs a key, a label and a group: ' + JSON.stringify(t));
    assert.ok(['content', 'service', 'payment', 'access'].includes(t.group),
      `unknown group "${t.group}" on ${t.key} — the UI colours the pill by this`);
  });
  const filtered = await req('GET', '/admin/approval-queue?type=' + res.body.types.map((t) => t.key).join(','),
    { token: adminToken });
  assert.deepEqual(filtered.body.problems, [], 'a source failed when asked for by name');
});

test('an empty site returns an empty queue rather than an error', async () => {
  const res = await req('GET', '/admin/approval-queue', { token: adminToken });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.items, []);
  assert.equal(res.body.total, 0);
});

test('a pending article shows its reference code and payment status', async () => {
  const userId = await makeUser();
  const a = await pool.query(
    `INSERT INTO articles (author_user_id, title, body, status) VALUES ($1, 'Queue Test Story', 'Body', 'pending') RETURNING id`,
    [userId]
  );
  await makePayment(userId, 'article_publish', a.rows[0].id, { reference: 'ARTREF0001', status: 'confirmed' });

  const res = await req('GET', '/admin/approval-queue?type=article', { token: adminToken });
  assert.equal(res.status, 200);
  const row = res.body.items.find((i) => i.title === 'Queue Test Story');
  assert.ok(row, 'the pending article should be in the queue');
  assert.equal(row.reference, 'ARTREF0001');
  assert.equal(row.paymentStatus, 'Paid');
  assert.equal(row.typeLabel, 'Article');
  assert.equal(row.actions.approve.path, `/admin/articles/${a.rows[0].id}/approve`);
});

test('an unpaid submission reads "Awaiting payment", not blank', async () => {
  const userId = await makeUser();
  const a = await pool.query(
    `INSERT INTO articles (author_user_id, title, body, status) VALUES ($1, 'Unpaid Story', 'Body', 'pending') RETURNING id`,
    [userId]
  );
  await makePayment(userId, 'article_publish', a.rows[0].id, { reference: 'ARTREF0002', status: 'pending' });

  const res = await req('GET', '/admin/approval-queue?type=article', { token: adminToken });
  const row = res.body.items.find((i) => i.title === 'Unpaid Story');
  assert.equal(row.paymentStatus, 'Awaiting payment');
});

// ---------------------------------------------------------------------------
// AWAITING PAYMENT — visible, but not approvable until the money is in.
//
// These used to be filtered out of the queue entirely, so an admin could not
// see them at all: the member had submitted, and the dashboard showed nothing
// to act on. That is the "admin can't approve new articles" gap.
// ---------------------------------------------------------------------------

test('an article still AWAITING PAYMENT appears in the queue at all', async () => {
  const userId = await makeUser();
  await pool.query(
    `INSERT INTO articles (author_user_id, title, body, status)
     VALUES ($1, 'Submitted Not Paid', 'Body', 'awaiting_payment')`,
    [userId]
  );
  const res = await req('GET', '/admin/approval-queue?type=article', { token: adminToken });
  const row = res.body.items.find((i) => i.title === 'Submitted Not Paid');
  assert.ok(row, 'a submission nobody has paid for must still be VISIBLE to an admin');
  assert.equal(row.awaitingPayment, true);
});

test('...but it cannot be approved until it is paid for', async () => {
  const res = await req('GET', '/admin/approval-queue?type=article', { token: adminToken });
  const row = res.body.items.find((i) => i.title === 'Submitted Not Paid');
  assert.equal(row.actions.approve, undefined,
    'the approve action must be WITHHELD, not merely flagged — a screen that ignores the flag must still not publish it');
  assert.ok(row.approveBlockedReason, 'and it must say why');
  assert.ok(row.actions.reject, 'rejecting an unpaid submission stays available');
});

test('a CONFIRMED payment unblocks approval even if the item was never promoted', async () => {
  // orders.js swallows a failing per-item effect so one bad item cannot block a
  // whole cart — which can leave a paid article stranded at awaiting_payment.
  // Reading the payment directly is what lets it unblock itself here.
  const userId = await makeUser();
  const a = await pool.query(
    `INSERT INTO articles (author_user_id, title, body, status)
     VALUES ($1, 'Paid But Stranded', 'Body', 'awaiting_payment') RETURNING id`,
    [userId]
  );
  await makePayment(userId, 'article_publish', a.rows[0].id, { reference: 'ARTREF0009', status: 'confirmed' });

  const res = await req('GET', '/admin/approval-queue?type=article', { token: adminToken });
  const row = res.body.items.find((i) => i.title === 'Paid But Stranded');
  assert.equal(row.awaitingPayment, false);
  assert.equal(row.paidButNotPromoted, true, 'flagged so it is obvious why a paid item is still sitting here');
  assert.equal(row.actions.approve.path, `/admin/articles/${a.rows[0].id}/approve`,
    'a paid article MUST be approvable, however it got stuck');
});

test('a submission that is not payable is labelled so, not "awaiting payment"', async () => {
  const userId = await makeUser();
  await pool.query(
    `INSERT INTO investors (user_id, name, contact_email, status) VALUES ($1, 'Queue Investor', 'i@test.com', 'pending')`,
    [userId]
  );
  const res = await req('GET', '/admin/approval-queue?type=investor', { token: adminToken });
  const row = res.body.items.find((i) => i.title === 'Queue Investor');
  assert.ok(row);
  assert.equal(row.paymentStatus, 'Not payable');
});

test('an admin-added competition entry with no profile still appears', async () => {
  // The old Competitions tab inner-joined profiles, so every entry an admin
  // added by hand (manual_name, profile_id NULL) was invisible in the queue
  // that was supposed to be showing it to them.
  const comp = await pool.query(
    `INSERT INTO competitions (name, slug, opens_at, closes_at, status)
     VALUES ('AQ Comp', 'aq-comp', now(), now() + interval '30 days', 'open') RETURNING id`
  );
  await pool.query(
    `INSERT INTO competition_entries (competition_id, profile_id, manual_name, status)
     VALUES ($1, NULL, 'Hand Added Contestant', 'pending')`,
    [comp.rows[0].id]
  );

  const res = await req('GET', '/admin/approval-queue?type=competition_entry', { token: adminToken });
  const row = res.body.items.find((i) => i.title === 'Hand Added Contestant');
  assert.ok(row, 'an entry with no profile row must still reach the queue');
  assert.equal(row.subtitle, 'AQ Comp');
});

test('a vote purchase carries the contestant entry code as its reference', async () => {
  const ownerId = await makeUser();
  const profileId = await makeProfile(ownerId);
  const comp = await pool.query(
    `INSERT INTO competitions (name, slug, opens_at, closes_at, status)
     VALUES ('AQ Votes', 'aq-votes', now(), now() + interval '30 days', 'open') RETURNING id`
  );
  const entry = await pool.query(
    `INSERT INTO competition_entries (competition_id, profile_id, status, entry_code)
     VALUES ($1, $2, 'approved', '0009998887') RETURNING id`,
    [comp.rows[0].id, profileId]
  );
  const buyerId = await makeUser();
  await pool.query(
    `INSERT INTO vote_bundles (entry_id, buyer_user_id, vote_count, price, status, reference)
     VALUES ($1, $2, 50, 250, 'awaiting_payment', '0009998887')`,
    [entry.rows[0].id, buyerId]
  );

  const res = await req('GET', '/admin/approval-queue?type=top10_votes', { token: adminToken });
  const row = res.body.items[0];
  assert.ok(row);
  assert.equal(row.reference, '0009998887');
  assert.equal(row.entryCode, '0009998887');
  assert.equal(row.subtitle, '50 votes');
  assert.equal(row.typeLabel, 'Top 10 Vote Purchase');
});

test('A VOTE PURCHASE AWAITING PAYMENT IS APPROVABLE — approving IS confirming it', async () => {
  // The live bug this pins: every Top 10 vote purchase sits at
  // 'awaiting_payment' by definition — that is what an EFT waiting to be
  // checked off looks like — and the approve endpoint is what marks it
  // received and allocates the votes. Gating it on "is it paid?" locked the
  // admin out of confirming any vote payment at all.
  const res = await req('GET', '/admin/approval-queue?type=top10_votes', { token: adminToken });
  const row = res.body.items[0];
  assert.ok(row, 'the purchase must be in the queue');
  assert.equal(row.group, 'payment');
  assert.equal(row.awaitingPayment, false,
    'a payment row is never "waiting for payment" — the admin IS the payment check');
  assert.ok(row.actions.approve, 'APPROVE MUST BE AVAILABLE — this is how an EFT gets confirmed');
  assert.match(row.actions.approve.path, /vote-bundles\/\d+\/approve/);
});

test('every payment-group row keeps its approve action', async () => {
  // Cart orders, service payments and edition purchases are confirmations
  // too. None of them may ever be gated behind "has it been paid for", because
  // approving them is precisely how that question gets answered.
  const res = await req('GET', '/admin/approval-queue', { token: adminToken });
  const payments = res.body.items.filter((i) => i.group === 'payment');
  assert.ok(payments.length > 0, 'there must be payment rows to check');
  payments.forEach((row) => {
    assert.ok(row.actions.approve,
      `${row.typeLabel} must stay approvable — it is a payment confirmation, not a publishing decision`);
    assert.equal(row.awaitingPayment, false, `${row.typeLabel} must not be flagged as blocked`);
  });
});

test('an order-linked payment appears once, as its order — never twice', async () => {
  const userId = await makeUser();
  const order = await pool.query(
    `INSERT INTO orders (user_id, reference, method, status, subtotal, total, terms_version, terms_accepted_at, info_confirmed_at)
     VALUES ($1, 'ORD-AQ-001', 'eft', 'pending', 300, 300, 'v1', now(), now()) RETURNING id`,
    [userId]
  );
  const a = await pool.query(
    `INSERT INTO articles (author_user_id, title, body, status) VALUES ($1, 'In A Cart', 'Body', 'approved') RETURNING id`,
    [userId]
  );
  await makePayment(userId, 'article_publish', a.rows[0].id, { reference: 'ORDCHILD1', orderId: order.rows[0].id });

  const res = await req('GET', '/admin/approval-queue', { token: adminToken });
  const refs = res.body.items.map((i) => i.reference);
  assert.ok(refs.includes('ORD-AQ-001'), 'the parent order should be listed');
  assert.ok(!refs.includes('ORDCHILD1'), 'the order-linked payment must not also be listed on its own');
});

test('the type filter and the search both narrow the queue', async () => {
  const all = await req('GET', '/admin/approval-queue', { token: adminToken });
  const onlyArticles = await req('GET', '/admin/approval-queue?type=article', { token: adminToken });
  assert.ok(onlyArticles.body.items.length < all.body.items.length);
  assert.ok(onlyArticles.body.items.every((i) => i.type === 'article'));

  const searched = await req('GET', '/admin/approval-queue?q=ARTREF0001', { token: adminToken });
  assert.equal(searched.body.items.length, 1);
  assert.equal(searched.body.items[0].reference, 'ARTREF0001');
});

test('counts are reported per type', async () => {
  const res = await req('GET', '/admin/approval-queue', { token: adminToken });
  const articleRows = res.body.items.filter((i) => i.type === 'article').length;
  assert.equal(res.body.counts.article, articleRows);
});

test('the queue is admin-only', async () => {
  assert.equal((await req('GET', '/admin/approval-queue')).status, 401);
  assert.equal((await req('GET', '/admin/approval-queue', { token: memberToken })).status, 403);
});
