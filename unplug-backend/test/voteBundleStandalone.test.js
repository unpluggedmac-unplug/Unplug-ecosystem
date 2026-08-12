// Payment Portal Redevelopment — Phase 2: Top 10 Bulk Votes as a fully
// separate, anonymous portal (095_vote_bundle_standalone_portal.sql).
//
// Covers: search-by-name, the enriched entry lookup (photo/category/vote
// count), the standalone create+pay call (no /payments/initiate, no
// login), the mandatory Terms gate, and the admin approve/reject/reverse
// queue including that approve actually allocates votes and reverse
// actually removes them. Over real HTTP against real PostgreSQL. See
// universalComments.test.js for why require('../src/app') is avoided.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-votebundle-'));
const port = 20800 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

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
  return jwt.sign({ id: userId, email: `votebundle${userId}@test.com`, role }, process.env.JWT_SECRET);
}

let _nextUserId = 25000;
async function makeUser(role = 'member') {
  const id = _nextUserId++;
  await pool.query(`INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', $3) ON CONFLICT DO NOTHING`, [id, `votebundle${id}@test.com`, role]);
  return id;
}

let _nextSlug = 0;
async function makeApprovedEntry(name) {
  const owner = await makeUser();
  const profile = await pool.query(
    `INSERT INTO profiles (user_id, type, package_tier, slug, display_name, status, feature_image_url)
     VALUES ($1, 'individual', 'basic', $2, $3, 'approved', $4) RETURNING id`,
    [owner, `votebundle-${_nextSlug++}`, name, `https://example.test/${name.replace(/\s+/g, '')}.jpg`]
  );
  const top10 = await pool.query(`SELECT id FROM competitions WHERE slug = 'top-10'`);
  const entry = await pool.query(
    `INSERT INTO competition_entries (competition_id, profile_id, status) VALUES ($1, $2, 'approved') RETURNING id`,
    [top10.rows[0].id, profile.rows[0].id]
  );
  // The entry_code trigger fires on transition INTO 'approved' — inserting
  // directly as 'approved' still fires it (AFTER INSERT/UPDATE trigger),
  // so read the code back rather than assuming one.
  const withCode = await pool.query(`SELECT id, entry_code FROM competition_entries WHERE id = $1`, [entry.rows[0].id]);
  return withCode.rows[0];
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
  process.env.JWT_SECRET = 'test-secret-for-votebundle';
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
  app.use('/', require('../src/routes/competitions'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await pool.end();
  await pg.stop();
});

test('an approved entry gets a real 10-digit entry_code automatically', async () => {
  const entry = await makeApprovedEntry('Thabo Nkosi');
  assert.match(entry.entry_code, /^[0-9]{10}$/);
});

test('GET /entries/search finds a contestant by (partial) name and reports photo/category/vote count', async () => {
  const entry = await makeApprovedEntry('Zanele Dlamini');
  const { status, body } = await req('GET', '/entries/search?q=zanele&competitionSlug=top-10');
  assert.equal(status, 200);
  const found = body.entries.find((e) => e.id === entry.id);
  assert.ok(found, 'the entry did not appear in search results');
  assert.equal(found.vote_count, 0);
  assert.ok(found.image_url);
});

test('GET /entries/search requires at least 2 characters', async () => {
  const { status } = await req('GET', '/entries/search?q=z');
  assert.equal(status, 400);
});

test('GET /entries/by-code resolves the same enriched shape (photo/category/vote count)', async () => {
  const entry = await makeApprovedEntry('Sipho Mokoena');
  const { status, body } = await req('GET', `/entries/by-code/${entry.entry_code}`);
  assert.equal(status, 200);
  assert.equal(body.entry.id, entry.id);
  assert.equal(body.entry.vote_count, 0);
  assert.ok('category' in body.entry);
});

test('a vote-bundle purchase works fully anonymously — no token, just a sessionId — and is refused without accepting Terms', async () => {
  const entry = await makeApprovedEntry('Anonymous Buyer Target');

  const noTerms = await req('POST', `/entries/${entry.id}/vote-bundle`, { body: { votes: 10, sessionId: 'sess_no_terms' } });
  assert.equal(noTerms.status, 400);
  assert.match(noTerms.body.error, /Terms/);

  const ok = await req('POST', `/entries/${entry.id}/vote-bundle`, { body: { votes: 10, sessionId: 'sess_anon_1', termsAccepted: true } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.ok(ok.body.reference);
  assert.ok(ok.body.instructions);
  assert.equal(ok.body.instructions.reference, ok.body.reference);
});

test('a vote-bundle purchase never touches /payments/initiate or the payments table at all', async () => {
  const entry = await makeApprovedEntry('Isolated From Payments Table');
  await req('POST', `/entries/${entry.id}/vote-bundle`, { body: { votes: 10, sessionId: 'sess_isolated', termsAccepted: true } });
  const paymentsRows = await pool.query(`SELECT COUNT(*)::int AS n FROM payments WHERE linked_type = 'vote_bundle'`);
  assert.equal(paymentsRows.rows[0].n, 0, 'a vote_bundle purchase created a row in the shared payments table');
});

test('admin approve allocates the votes; a re-approve or an approve of a non-existent status is refused', async () => {
  const admin = await makeUser('admin');
  const entry = await makeApprovedEntry('Approve Me Please');
  const purchase = await req('POST', `/entries/${entry.id}/vote-bundle`, { body: { votes: 50, sessionId: 'sess_approve_1', termsAccepted: true } });
  const bundleId = purchase.body.bundle.id;

  const approve = await req('PATCH', `/admin/vote-bundles/${bundleId}/approve`, { token: tokenFor(admin, 'admin') });
  assert.equal(approve.status, 200);

  const votesRow = await pool.query(`SELECT bundle_size FROM votes WHERE entry_id = $1 AND session_id = $2`, [entry.id, 'sess_approve_1']);
  assert.equal(votesRow.rows[0].bundle_size, 50);

  const reapprove = await req('PATCH', `/admin/vote-bundles/${bundleId}/approve`, { token: tokenFor(admin, 'admin') });
  assert.equal(reapprove.status, 400);
});

test('a non-admin cannot approve, reject or reverse a bundle', async () => {
  const member = await makeUser();
  const entry = await makeApprovedEntry('Not An Admin Target');
  const purchase = await req('POST', `/entries/${entry.id}/vote-bundle`, { body: { votes: 10, sessionId: 'sess_notadmin', termsAccepted: true } });
  const bundleId = purchase.body.bundle.id;
  assert.equal((await req('PATCH', `/admin/vote-bundles/${bundleId}/approve`, { token: tokenFor(member) })).status, 403);
  assert.equal((await req('PATCH', `/admin/vote-bundles/${bundleId}/reject`, { token: tokenFor(member) })).status, 403);
  assert.equal((await req('POST', `/admin/vote-bundles/${bundleId}/reverse`, { token: tokenFor(member) })).status, 403);
});

test('admin reject leaves no votes allocated; admin reverse removes votes an approval already added', async () => {
  const admin = await makeUser('admin');
  const entry = await makeApprovedEntry('Reject And Reverse Target');

  const rejectPurchase = await req('POST', `/entries/${entry.id}/vote-bundle`, { body: { votes: 10, sessionId: 'sess_reject', termsAccepted: true } });
  await req('PATCH', `/admin/vote-bundles/${rejectPurchase.body.bundle.id}/reject`, { token: tokenFor(admin, 'admin') });
  const afterReject = await pool.query(`SELECT 1 FROM votes WHERE entry_id = $1 AND session_id = 'sess_reject'`, [entry.id]);
  assert.equal(afterReject.rows.length, 0);

  const reversePurchase = await req('POST', `/entries/${entry.id}/vote-bundle`, { body: { votes: 50, sessionId: 'sess_reverse', termsAccepted: true } });
  assert.equal(reversePurchase.status, 201, JSON.stringify(reversePurchase.body));
  const bundleId = reversePurchase.body.bundle.id;
  await req('PATCH', `/admin/vote-bundles/${bundleId}/approve`, { token: tokenFor(admin, 'admin') });
  const afterApprove = await pool.query(`SELECT bundle_size FROM votes WHERE entry_id = $1 AND session_id = 'sess_reverse'`, [entry.id]);
  assert.equal(afterApprove.rows[0].bundle_size, 50);

  const reverse = await req('POST', `/admin/vote-bundles/${bundleId}/reverse`, { token: tokenFor(admin, 'admin') });
  assert.equal(reverse.status, 200);
  // Asserts the OUTCOME (no votes left for this buyer) rather than the
  // mechanism. Reversal used to zero the bundle_size of a shared row; since
  // 098_daily_voting.sql a bundle owns its row and reversal deletes it, so
  // checking for a surviving row holding 0 would test how it happens rather
  // than that it happened. The sum is what every caller actually reads.
  const afterReverse = await pool.query(
    `SELECT COALESCE(SUM(bundle_size), 0)::int AS n FROM votes WHERE entry_id = $1 AND session_id = 'sess_reverse'`,
    [entry.id]
  );
  assert.equal(afterReverse.rows[0].n, 0);
});

test('the Reference Code IS the contestant entry code, and the buyer is told so', async () => {
  // Superseded 104's entry-code-PLUS-suffix design: one code, called the
  // Reference Code, everywhere a customer sees it
  // (106_vote_reference_is_entry_code.sql).
  const entry = await makeApprovedEntry('Reference Prefix Target');
  const res = await req('POST', `/entries/${entry.id}/vote-bundle`, {
    body: { votes: 50, sessionId: 'sess_ref_prefix', termsAccepted: true },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.entryCode, entry.entry_code);
  assert.equal(res.body.reference, entry.entry_code, 'the reference is the entry code, with nothing appended');
  assert.equal(res.body.instructions.reference, res.body.reference);
  assert.match(res.body.instructions.note, new RegExp(entry.entry_code));
});

test('two purchases for the SAME contestant share the Reference Code but stay separate orders', async () => {
  // The accepted cost of one shared code: the admin queue can no longer tell
  // two EFTs apart by reference alone, and matches on amount, date and buyer
  // instead. What must NOT happen is the second purchase failing — reference
  // used to be UNIQUE, so before migration 106 this was a duplicate-key error
  // in the middle of someone's checkout.
  const entry = await makeApprovedEntry('Two Buyers One Contestant');
  const a = await req('POST', `/entries/${entry.id}/vote-bundle`, {
    body: { votes: 50, sessionId: 'buyer_a', termsAccepted: true },
  });
  const b = await req('POST', `/entries/${entry.id}/vote-bundle`, {
    body: { votes: 50, sessionId: 'buyer_b', termsAccepted: true },
  });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.equal(a.body.reference, b.body.reference, 'both quote the contestant entry code');
  assert.equal(a.body.reference, entry.entry_code);
  assert.notEqual(a.body.lookupToken, b.body.lookupToken, 'each order still has its own private handle');
});

test('the buyer resolves their own order through the public status lookup', async () => {
  const entry = await makeApprovedEntry('Longer Reference Lookup');
  const purchase = await req('POST', `/entries/${entry.id}/vote-bundle`, {
    body: { votes: 50, sessionId: 'sess_lookup_long', termsAccepted: true },
  });
  const token = purchase.body.lookupToken;

  const status = await req('GET', `/vote-bundles/status/${token}`);
  assert.equal(status.status, 200);
  assert.equal(status.body.purchase.entry_code, entry.entry_code);
  // Lookups uppercase the input, so a lowercase-typed handle still works.
  const lower = await req('GET', `/vote-bundles/status/${token.toLowerCase()}`);
  assert.equal(lower.status, 200);

  // And the Reference Code alone is refused — it is a public entry code now,
  // so it identifies the contestant, never the order.
  const byCode = await req('GET', `/vote-bundles/status/${entry.entry_code}`);
  assert.equal(byCode.status, 404);
});

test('GET /admin/vote-bundles searches by contestant name, reference and entry code, and filters by status', async () => {
  const admin = await makeUser('admin');
  const entry = await makeApprovedEntry('Searchable Admin Target');
  const purchase = await req('POST', `/entries/${entry.id}/vote-bundle`, { body: { votes: 10, sessionId: 'sess_admin_search', termsAccepted: true } });
  const reference = purchase.body.reference;

  const byName = await req('GET', '/admin/vote-bundles?q=Searchable Admin', { token: tokenFor(admin, 'admin') });
  assert.ok(byName.body.bundles.some((b) => b.reference === reference));

  const byReference = await req('GET', `/admin/vote-bundles?q=${reference}`, { token: tokenFor(admin, 'admin') });
  assert.ok(byReference.body.bundles.some((b) => b.reference === reference));

  const byCode = await req('GET', `/admin/vote-bundles?q=${entry.entry_code}`, { token: tokenFor(admin, 'admin') });
  assert.ok(byCode.body.bundles.some((b) => b.reference === reference));

  const byStatus = await req('GET', '/admin/vote-bundles?status=confirmed', { token: tokenFor(admin, 'admin') });
  assert.ok(!byStatus.body.bundles.some((b) => b.reference === reference), 'an awaiting_payment bundle appeared under the confirmed filter');
});

test('re-running every migration is idempotent — vote_bundles reference/terms columns and status values survive', async () => {
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }
  const cols = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'vote_bundles' AND column_name IN ('reference', 'terms_accepted_at', 'confirmed_at', 'rejected_at')`
  );
  assert.equal(cols.rows.length, 4);
});
