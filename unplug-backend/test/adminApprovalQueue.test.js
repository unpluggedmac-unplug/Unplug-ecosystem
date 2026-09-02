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
const { stopPostgres } = require('./helpers/stopPostgres');

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
  // stopPostgres, not pg.stop() directly: on Windows the library's stop
  // can HANG rather than throw, which used to leave the cluster running
  // with no parent and eventually broke a later test file's startup.
  // See test/helpers/stopPostgres.js.
  await stopPostgres(pg, dataDir);
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

// ---------------------------------------------------------------------------
// Resubmitted work must not fall out of the queue.
// ---------------------------------------------------------------------------
//
// The queue selected `pending` and `awaiting_payment` only. `resubmitted` — the
// status a submission takes when a member has answered a change request — was
// missing from every source.
//
// Nothing sets it yet, so nothing was broken. But the moment the
// request-changes pathway ships, a member answering a change request would have
// moved their submission into a status the queue does not select: it would have
// disappeared, nobody would have seen it, and the member would have waited for
// a decision that was never coming.
//
// These check the behaviour, not the SQL text, so they keep working if the
// queries are rewritten.

const fsQ = require('fs');
const pathQ = require('path');

test('A RESUBMITTED ARTICLE IS STILL IN THE ADMIN QUEUE', async () => {
  const author = await makeUser();
  const a = await pool.query(
    `INSERT INTO articles (author_user_id, title, body, status)
     VALUES ($1, 'Answered the change request', 'Body text for the article.', 'resubmitted')
     RETURNING id`,
    [author]
  );
  const res = await req('GET', '/admin/approval-queue', { token: adminToken });
  assert.equal(res.status, 200);

  const items = res.body.items || [];
  const mine = items.find((i) => i.type === 'article' && Number(i.id) === a.rows[0].id);
  assert.ok(mine, 'a resubmitted article must appear as work waiting on an admin');
});

test('a resubmitted marketplace listing is still in the queue', async () => {
  // A second service, because the fix had to reach every source rather than
  // the one that happened to be tested.
  const owner = await makeUser();
  const adv = await pool.query(
    `INSERT INTO advertisers (user_id, business_name) VALUES ($1, 'Test Advertiser') RETURNING id`,
    [owner]
  );
  const l = await pool.query(
    `INSERT INTO marketplace_listings (advertiser_id, poster_image_url, headline, duration_days, status)
     VALUES ($1, 'https://unplugnews.com/p.jpg', 'Answered', 30, 'resubmitted') RETURNING id`,
    [adv.rows[0].id]
  );
  const res = await req('GET', '/admin/approval-queue', { token: adminToken });
  const mine = (res.body.items || []).find(
    (i) => i.type === 'marketplace' && Number(i.id) === l.rows[0].id
  );
  assert.ok(mine, 'a resubmitted listing must appear in the queue');
});

test('EVERY SPINE SERVICE IN THE QUEUE SELECTS resubmitted', () => {
  // Which sources must carry it is decided by the spine, not by eye: a table
  // needs `resubmitted` in its filter exactly when `resubmitted` is a status it
  // can hold. So the list comes from submissionStatus.SUBMISSION_TABLES rather
  // than being typed out here and left to drift.
  //
  // The queue also serves flows that are NOT part of the spine — orders,
  // payments and vote_bundles use payment vocabularies (pending/confirmed/
  // failed), and share_cards, shoutout_nominations and profile_claims are
  // separate review flows with their own statuses. `resubmitted` has no meaning
  // in any of them, so requiring it there would be wrong rather than thorough.
  //
  // Read out of the route so a new spine source added without it fails here,
  // rather than silently swallowing a member's answered change request.
  const SUB = require('../src/utils/submissionStatus');
  const src = fsQ.readFileSync(
    pathQ.join(__dirname, '..', 'src', 'routes', 'adminApprovalQueue.js'), 'utf8'
  );
  const lines = src.split('\n');
  const missing = [];

  lines.forEach((line, i) => {
    if (!/\bstatus\s*(IN\s*\(|=\s*')/.test(line)) return;
    if (!/WHERE|AND/.test(line)) return;

    let table = '?';
    for (let j = i; j >= Math.max(0, i - 14); j--) {
      const m = lines[j].match(/FROM (\w+)/);
      if (m) { table = m[1]; break; }
    }
    if (!SUB.SUBMISSION_TABLES.includes(table)) return;      // not a spine service
    if (!line.includes('resubmitted')) missing.push(`${table} (line ${i + 1})`);
  });

  assert.deepEqual(missing, [],
    'these spine services would lose resubmitted work: ' + missing.join(', '));
});

test('the queue reaches every spine service that can be resubmitted', () => {
  // The other half: a service whose migration gave it `resubmitted` but which
  // the queue never selects at all would lose the work just as completely, and
  // the test above cannot see that because there is no line to inspect.
  const SUB = require('../src/utils/submissionStatus');
  const src = fsQ.readFileSync(
    pathQ.join(__dirname, '..', 'src', 'routes', 'adminApprovalQueue.js'), 'utf8'
  );
  const canResubmit = SUB.SUBMISSION_TABLES.filter((t) => SUB.isLiveFor('resubmitted', t));
  const unreachable = canResubmit.filter((t) => !new RegExp(`FROM ${t}\\b`).test(src));

  // gallery_bundles is reviewed through its images rather than as a row of its
  // own, which is why the queue selects gallery_images.
  assert.deepEqual(unreachable, ['gallery_bundles'],
    'spine services that accept resubmitted but never appear in the queue: ' + unreachable.join(', '));
});

test('adding resubmitted did not pull in anything already decided', () => {
  // The queue is "what is waiting". An approved or rejected item appearing here
  // would be the opposite failure — an admin re-deciding settled work.
  const src = fsQ.readFileSync(
    pathQ.join(__dirname, '..', 'src', 'routes', 'adminApprovalQueue.js'), 'utf8'
  );
  ['\'approved\'', '\'rejected\'', '\'credit_issued\''].forEach((v) => {
    const inFilter = new RegExp(`status IN \\([^)]*${v}`).test(src);
    assert.equal(inFilter, false, `${v} must not be selected as work waiting`);
  });
});