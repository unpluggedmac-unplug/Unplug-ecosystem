// Daily voting for the Top 10 (098_daily_voting.sql).
//
// The two things that actually matter and are easy to get wrong:
//   - a voter can vote again on a NEW day, but not twice on the same day;
//   - the running total never resets — it accumulates across days, and
//     across free + paid votes together.
//
// Also guards the blast radius: the Arena must keep its one-vote-per-person
// rule, and paid bundles must still allocate and reverse correctly now that
// they own their votes row instead of merging into the voter's.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-dailyvote-'));
const port = 21600 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

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
  return jwt.sign({ id: userId, email: `dailyvote${userId}@test.com`, role }, process.env.JWT_SECRET);
}

let _nextUserId = 41000;
async function makeUser(role = 'member') {
  const id = _nextUserId++;
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', $3) ON CONFLICT DO NOTHING`,
    [id, `dailyvote${id}@test.com`, role]
  );
  return id;
}

let _nextSlug = 0;
// competitionSlug lets a test target the Arena (one vote ever) instead of
// the Top 10 (one vote a day).
async function makeApprovedEntry(name, competitionSlug = 'top-10') {
  const owner = await makeUser();
  const profile = await pool.query(
    `INSERT INTO profiles (user_id, type, package_tier, slug, display_name, status)
     VALUES ($1, 'individual', 'basic', $2, $3, 'approved') RETURNING id`,
    [owner, `dailyvote-${_nextSlug++}`, name]
  );
  const comp = await pool.query(`SELECT id FROM competitions WHERE slug = $1`, [competitionSlug]);
  assert.ok(comp.rows.length, `expected a seeded '${competitionSlug}' competition`);
  const entry = await pool.query(
    `INSERT INTO competition_entries (competition_id, profile_id, status) VALUES ($1, $2, 'approved') RETURNING id`,
    [comp.rows[0].id, profile.rows[0].id]
  );
  return entry.rows[0].id;
}

// The one thing every caller uses as the source of truth for a total.
async function totalVotes(entryId) {
  const r = await pool.query(`SELECT COALESCE(SUM(bundle_size), 0)::int AS n FROM votes WHERE entry_id = $1`, [entryId]);
  return r.rows[0].n;
}

// Rewrites a vote's day to simulate the clock moving on, which is the only
// practical way to test "tomorrow" without waiting for it.
async function backdateVotes(entryId, days) {
  await pool.query(
    `UPDATE votes SET vote_day = vote_day - ($2 || ' days')::interval
      WHERE entry_id = $1 AND vote_day IS NOT NULL`,
    [entryId, String(days)]
  );
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
  process.env.JWT_SECRET = 'test-secret-for-dailyvote';
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
  // Windows can still hold a handle on the data directory when Postgres
  // exits, and embedded-postgres removes that directory as part of
  // stopping. The server is already down by then, so an EBUSY here is
  // the OS being slow to let go, not a failure worth failing the file
  // for — and a teardown that goes red teaches everyone to ignore red.
  try { if (pg) await pg.stop(); } catch (e) { /* see above */ }
});

// ---------------------------------------------------------------------------
// The rule itself
// ---------------------------------------------------------------------------

test('the Top 10 is configured for daily voting and the Arena is not', async () => {
  const r = await pool.query(`SELECT slug, daily_voting FROM competitions WHERE slug IN ('top-10', 'the-arena')`);
  const bySlug = Object.fromEntries(r.rows.map((x) => [x.slug, x.daily_voting]));
  assert.equal(bySlug['top-10'], true);
  assert.equal(bySlug['the-arena'], false, 'the Arena must keep one-vote-per-person');
});

test('a signed-in voter cannot vote twice for the same entry on the same day', async () => {
  const entry = await makeApprovedEntry('Same Day User');
  const voter = await makeUser();

  const first = await req('POST', `/entries/${entry}/vote`, { token: tokenFor(voter) });
  assert.equal(first.status, 201);
  assert.equal(first.body.dailyVoting, true);

  const second = await req('POST', `/entries/${entry}/vote`, { token: tokenFor(voter) });
  assert.equal(second.status, 409);
  assert.equal(second.body.votedToday, true);
  assert.match(second.body.error, /again tomorrow/);
  assert.equal(await totalVotes(entry), 1);
});

test('the same voter CAN vote again on a new day, and the total adds up rather than resetting', async () => {
  const entry = await makeApprovedEntry('Next Day User');
  const voter = await makeUser();

  assert.equal((await req('POST', `/entries/${entry}/vote`, { token: tokenFor(voter) })).status, 201);
  await backdateVotes(entry, 1); // pretend that vote was yesterday
  assert.equal((await req('POST', `/entries/${entry}/vote`, { token: tokenFor(voter) })).status, 201);
  assert.equal(await totalVotes(entry), 2, 'day two should ADD to day one, not replace it');

  await backdateVotes(entry, 1);
  assert.equal((await req('POST', `/entries/${entry}/vote`, { token: tokenFor(voter) })).status, 201);
  assert.equal(await totalVotes(entry), 3);
});

test('a guest gets the same one-a-day rule, keyed on their session', async () => {
  const entry = await makeApprovedEntry('Guest Daily');
  const sessionId = 'guest-session-daily-1';

  assert.equal((await req('POST', `/entries/${entry}/vote`, { body: { sessionId } })).status, 201);
  const dupe = await req('POST', `/entries/${entry}/vote`, { body: { sessionId } });
  assert.equal(dupe.status, 409);
  assert.equal(dupe.body.votedToday, true);

  await backdateVotes(entry, 1);
  assert.equal((await req('POST', `/entries/${entry}/vote`, { body: { sessionId } })).status, 201);
  assert.equal(await totalVotes(entry), 2);

  // A different guest is unaffected by the first one's vote.
  assert.equal((await req('POST', `/entries/${entry}/vote`, { body: { sessionId: 'guest-session-daily-2' } })).status, 201);
  assert.equal(await totalVotes(entry), 3);
});

test('two different voters can both vote for the same entry on the same day', async () => {
  const entry = await makeApprovedEntry('Popular Person');
  const a = await makeUser();
  const b = await makeUser();
  assert.equal((await req('POST', `/entries/${entry}/vote`, { token: tokenFor(a) })).status, 201);
  assert.equal((await req('POST', `/entries/${entry}/vote`, { token: tokenFor(b) })).status, 201);
  assert.equal(await totalVotes(entry), 2);
});

// ---------------------------------------------------------------------------
// Blast radius: the Arena must not have changed
// ---------------------------------------------------------------------------

test('an Arena entry still allows only ONE vote per voter, ever — not one a day', async () => {
  const entry = await makeApprovedEntry('Arena Contender', 'the-arena');
  const voter = await makeUser();

  const first = await req('POST', `/entries/${entry}/vote`, { token: tokenFor(voter) });
  assert.equal(first.status, 201);
  assert.equal(first.body.dailyVoting, false);

  const second = await req('POST', `/entries/${entry}/vote`, { token: tokenFor(voter) });
  assert.equal(second.status, 409);
  assert.equal(second.body.votedToday, false, 'the Arena message must not promise a vote tomorrow');
  assert.match(second.body.error, /already voted for this entry\.$/);

  // Even with the clock moved on, an Arena vote is still one-and-done. Its
  // rows carry no vote_day, so backdating is a no-op here by design.
  await backdateVotes(entry, 5);
  assert.equal((await req('POST', `/entries/${entry}/vote`, { token: tokenFor(voter) })).status, 409);
  assert.equal(await totalVotes(entry), 1);
});

// ---------------------------------------------------------------------------
// Paid bundles alongside daily free votes
// ---------------------------------------------------------------------------

async function makeConfirmedBundle(entryId, voterUserId, votes) {
  const admin = await makeUser('admin');
  const bundle = await pool.query(
    `INSERT INTO vote_bundles (entry_id, buyer_user_id, vote_count, price, reference, terms_accepted_at, terms_version)
     VALUES ($1, $2, $3, $4, $5, now(), 'v1') RETURNING id`,
    // vote_bundles.reference is VARCHAR(10) and UNIQUE.
    [entryId, voterUserId, votes, votes * 5, `DV${String(_nextSlug++).padStart(6, '0')}`]
  );
  const res = await req('PATCH', `/admin/vote-bundles/${bundle.rows[0].id}/approve`, { token: tokenFor(admin, 'admin') });
  assert.equal(res.status, 200);
  return { bundleId: bundle.rows[0].id, admin };
}

test('a paid bundle adds to the total and does NOT consume the buyer\'s free vote for the day', async () => {
  const entry = await makeApprovedEntry('Bundle Buyer');
  const voter = await makeUser();

  await makeConfirmedBundle(entry, voter, 50);
  assert.equal(await totalVotes(entry), 50);

  // The buyer's own free vote for today must still be available — the paid
  // row is separate, so it must not trip the daily uniqueness index.
  const free = await req('POST', `/entries/${entry}/vote`, { token: tokenFor(voter) });
  assert.equal(free.status, 201, 'buying votes must not use up the free daily vote');
  assert.equal(await totalVotes(entry), 51);
});

test('reversing a bundle removes exactly that bundle, leaving free daily votes intact', async () => {
  const entry = await makeApprovedEntry('Reverse Me');
  const voter = await makeUser();

  // Free vote today, then a second one "tomorrow", then a purchase.
  await req('POST', `/entries/${entry}/vote`, { token: tokenFor(voter) });
  await backdateVotes(entry, 1);
  await req('POST', `/entries/${entry}/vote`, { token: tokenFor(voter) });
  assert.equal(await totalVotes(entry), 2);

  const { bundleId, admin } = await makeConfirmedBundle(entry, voter, 70);
  assert.equal(await totalVotes(entry), 72);

  const rev = await req('POST', `/admin/vote-bundles/${bundleId}/reverse`, { token: tokenFor(admin, 'admin') });
  assert.equal(rev.status, 200);
  // Exactly the 70 purchased votes go. Both free daily votes survive — the
  // old subtract-by-voter reversal would have hit every day's row.
  assert.equal(await totalVotes(entry), 2, 'reversal must take only the bundle, not the free votes');
});

test('two bundles for the same entry and buyer are reversed independently', async () => {
  const entry = await makeApprovedEntry('Two Bundles');
  const voter = await makeUser();

  const first = await makeConfirmedBundle(entry, voter, 10);
  await makeConfirmedBundle(entry, voter, 200);
  assert.equal(await totalVotes(entry), 210);

  const rev = await req('POST', `/admin/vote-bundles/${first.bundleId}/reverse`, { token: tokenFor(first.admin, 'admin') });
  assert.equal(rev.status, 200);
  assert.equal(await totalVotes(entry), 200, 'only the reversed bundle should be removed');
});

test('the ONLINE paid-vote path (applyPaymentEffect) still allocates votes', async () => {
  // The other bundle tests go through the standalone admin-approve route.
  // This one exercises payments.js, which had its own copy of the old
  // merge-on-conflict insert — a clause that names indexes 098 removed, so
  // Postgres would reject the statement outright and every online vote
  // purchase would fail. Nothing else in the suite covered that path.
  const { applyPaymentEffect } = require('../src/routes/payments');
  assert.equal(typeof applyPaymentEffect, 'function', 'payments.js should expose applyPaymentEffect');

  const entry = await makeApprovedEntry('Online Buyer');
  const buyer = await makeUser();
  const bundle = await pool.query(
    `INSERT INTO vote_bundles (entry_id, buyer_user_id, vote_count, price, reference, terms_accepted_at, terms_version)
     VALUES ($1, $2, 30, 150, $3, now(), 'v1') RETURNING id`,
    [entry, buyer, `ON${String(_nextSlug++).padStart(6, '0')}`]
  );
  const payment = await pool.query(
    `INSERT INTO payments (user_id, amount, method, gateway_reference, status, linked_type, linked_id)
     VALUES ($1, 150, 'eft', $2, 'confirmed', 'vote_bundle', $3) RETURNING *`,
    [buyer, `ONPAY${_nextSlug++}`, bundle.rows[0].id]
  );

  await applyPaymentEffect(payment.rows[0]);
  assert.equal(await totalVotes(entry), 30);

  // And the buyer's free daily vote is still theirs to cast.
  assert.equal((await req('POST', `/entries/${entry}/vote`, { token: tokenFor(buyer) })).status, 201);
  assert.equal(await totalVotes(entry), 31);
});

// ---------------------------------------------------------------------------
// What the public leaderboard reports
// ---------------------------------------------------------------------------

test('the public entry list reports the accumulated multi-day total', async () => {
  const entry = await makeApprovedEntry('Leaderboard Check');
  const a = await makeUser();
  const b = await makeUser();

  await req('POST', `/entries/${entry}/vote`, { token: tokenFor(a) });
  await req('POST', `/entries/${entry}/vote`, { token: tokenFor(b) });
  await backdateVotes(entry, 1);
  await req('POST', `/entries/${entry}/vote`, { token: tokenFor(a) });
  await makeConfirmedBundle(entry, b, 20);

  const { status, body } = await req('GET', '/entries/search?q=Leaderboard&competitionSlug=top-10');
  assert.equal(status, 200);
  const found = body.entries.find((e) => e.id === entry);
  assert.ok(found, 'entry missing from search results');
  assert.equal(found.vote_count, 23, '2 votes day one + 1 day two + 20 purchased');
});

test('re-running every migration is idempotent — the voting rules and indexes survive', async () => {
  const entry = await makeApprovedEntry('Idempotent');
  const voter = await makeUser();
  await req('POST', `/entries/${entry}/vote`, { token: tokenFor(voter) });

  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }

  // Still exactly one vote, still daily, still blocked for a second today.
  assert.equal(await totalVotes(entry), 1);
  const again = await req('POST', `/entries/${entry}/vote`, { token: tokenFor(voter) });
  assert.equal(again.status, 409);
  const flag = await pool.query(`SELECT daily_voting FROM competitions WHERE slug = 'top-10'`);
  assert.equal(flag.rows[0].daily_voting, true);
});
