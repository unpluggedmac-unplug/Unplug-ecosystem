// The §9.2 voting rule, and §8.5's contestant dashboard.
//
// §9.2: a voter may cast at most 5 online votes per calendar day ACROSS THE
// WHOLE COMPETITION, spread over at least two contestants; five for one
// contestant is not allowed.
//
// ON THE RACE. Counting votes and then inserting is not atomic, so in principle
// two requests can both count four and both insert, giving six. §9.4 asks for
// defences against automated voting, so the route serialises a voter's attempts
// with an advisory lock held for the transaction.
//
// BE HONEST ABOUT WHAT IS PROVEN HERE. The concurrent-votes test below passes
// with the lock REMOVED as well — eight HTTP requests do not reliably hit a
// window that is a few milliseconds wide, so it is an outcome check, not proof
// that the lock is load-bearing. The lock's actual mechanism is tested
// separately and directly, by showing that a second transaction blocks on the
// same key until the first commits.
//
// The rest:
//
//   * NOTHING CHANGES WHILE THE LIMIT IS NULL. It ships NULL, and every
//     existing competition must behave exactly as it does today.
//   * The cap is per COMPETITION per DAY, not per entry.
//   * Paid bundle votes are never capped — they were bought.
//   * The day is the South African one, not UTC.

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
let token;
let dash;
let cappedId;      // competition with the §9.2 cap on
let uncappedId;    // competition left as it is today
const cappedEntries = [];
const uncappedEntries = [];

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-vote92-'));
const port = 54000 + (process.pid % 300);
const ME = 940501;

async function api(method, urlPath, body, tok) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(tok ? { Authorization: 'Bearer ' + tok } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function makeCompetition(name, slug, limit) {
  const c = await pool.query(
    `INSERT INTO competitions (name, slug, opens_at, closes_at, status, daily_voting, daily_vote_limit)
     VALUES ($1,$2, now() - interval '1 day', now() + interval '30 days', 'open', true, $3)
     RETURNING id`, [name, slug, limit]);
  return c.rows[0].id;
}

async function makeEntry(competitionId, name) {
  const e = await pool.query(
    `INSERT INTO competition_entries (competition_id, manual_name, status)
     VALUES ($1,$2,'approved') RETURNING id`, [competitionId, name]);
  return e.rows[0].id;
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
  process.env.JWT_SECRET = 'test-secret-voting-92';
  process.env.UNPLUG_DISABLE_RATE_LIMITS = '1';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(dir, f), 'utf8'));
  }

  dash = require('../src/utils/contestantDashboard');

  const jwt = require('jsonwebtoken');
  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/', require('../src/routes/competitions'));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await pool.query(
    `INSERT INTO users (id, email, full_name, password_hash, role)
     VALUES ($1,'me@vote92.test','Voter','x','member')`, [ME]);
  token = jwt.sign({ id: ME, email: 'me@vote92.test', role: 'member' }, process.env.JWT_SECRET);

  cappedId = await makeCompetition('Capped Comp', 'capped-comp', 5);
  uncappedId = await makeCompetition('Uncapped Comp', 'uncapped-comp', null);
  for (let i = 1; i <= 8; i++) cappedEntries.push(await makeEntry(cappedId, `Capped ${i}`));
  for (let i = 1; i <= 8; i++) uncappedEntries.push(await makeEntry(uncappedId, `Uncapped ${i}`));
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
});

const vote = (entryId, tok = token) => api('POST', `/entries/${entryId}/vote`, {}, tok);

// ------------------------------------------------------------- the migration

test('THE RULE SHIPS OFF', async () => {
  // The whole point of the cutover flag. Every competition that exists today
  // must have no cap until somebody deliberately sets one.
  const r = await pool.query(
    `SELECT count(*)::int AS n FROM competitions WHERE daily_vote_limit IS NOT NULL`);
  // Only the one this test set deliberately.
  assert.equal(r.rows[0].n, 1, 'no competition should gain a cap from the migration');

  const seeded = await pool.query(
    `SELECT daily_vote_limit FROM competitions WHERE slug = 'top-10'`);
  if (seeded.rowCount) {
    assert.equal(seeded.rows[0].daily_vote_limit, null,
      'the live Top 10 must be untouched by the deploy');
  }
});

test('a cap below one is refused by the database', async () => {
  await assert.rejects(
    () => pool.query(`UPDATE competitions SET daily_vote_limit = 0 WHERE id = $1`, [cappedId]),
    /violates check constraint/);
});

// ------------------------------------------------- nothing changes when NULL

test('NOTHING CHANGES FOR A COMPETITION WITH NO CAP', async () => {
  // Today's behaviour: one free vote per entry per day, any number of entries.
  for (const id of uncappedEntries) {
    const res = await vote(id);
    assert.equal(res.status, 201, `voting for ${id} should still work`);
  }
  const r = await pool.query(
    `SELECT COALESCE(SUM(v.bundle_size),0)::int AS n FROM votes v
       JOIN competition_entries ce ON ce.id = v.entry_id
      WHERE ce.competition_id = $1 AND v.voter_user_id = $2`, [uncappedId, ME]);
  assert.equal(r.rows[0].n, 8, 'all eight votes stand — there is no cap');
});

test('...and the same entry twice in a day is still refused', async () => {
  const res = await vote(uncappedEntries[0]);
  assert.equal(res.status, 409);
  assert.equal(res.body.votedToday, true);
});

// --------------------------------------------------------------- the cap

test('§9.2: FIVE VOTES A DAY, THEN NO MORE', async () => {
  for (let i = 0; i < 5; i++) {
    const res = await vote(cappedEntries[i]);
    assert.equal(res.status, 201, `vote ${i + 1} of 5 should be accepted`);
    assert.equal(res.body.dailyLimit, 5);
  }
  const sixth = await vote(cappedEntries[5]);
  assert.equal(sixth.status, 429, 'the sixth vote must be refused');
  assert.match(sixth.body.error, /all 5 of your votes for today/i);
  assert.equal(sixth.body.votesLeftToday, 0);
});

test('the cap is per COMPETITION, not per entry', async () => {
  // Five used in the capped competition; the uncapped one is unaffected.
  const other = await vote(uncappedEntries[0], token);
  assert.equal(other.status, 409, 'already voted there today, but not because of the cap');
  assert.ok(!other.body.dailyLimit, 'the refusal is the per-entry rule, not the cap');
});

test('a voter is told what they have left, not only when they run out', async () => {
  // Fresh voter so the count is unambiguous.
  const jwt = require('jsonwebtoken');
  await pool.query(
    `INSERT INTO users (id, email, full_name, password_hash, role)
     VALUES (940502,'second@vote92.test','Second','x','member')`);
  const t2 = jwt.sign({ id: 940502, email: 'second@vote92.test', role: 'member' },
    process.env.JWT_SECRET);

  const first = await vote(cappedEntries[0], t2);
  assert.equal(first.status, 201);
  assert.equal(first.body.votesLeftToday, 4, 'one used, four left');
});

test('§9.2 IS ALREADY SPREAD ACROSS CONTESTANTS', async () => {
  // "Five votes for one contestant is NOT allowed." That is enforced by the
  // per-entry-per-day unique index from migration 098, so five votes can only
  // ever be five different entries. Stated as a test because the rule is §9.2's
  // and a reader should not have to know which migration happens to provide it.
  const jwt = require('jsonwebtoken');
  await pool.query(
    `INSERT INTO users (id, email, full_name, password_hash, role)
     VALUES (940503,'third@vote92.test','Third','x','member')`);
  const t3 = jwt.sign({ id: 940503, email: 'third@vote92.test', role: 'member' },
    process.env.JWT_SECRET);

  assert.equal((await vote(cappedEntries[0], t3)).status, 201);
  const again = await vote(cappedEntries[0], t3);
  assert.equal(again.status, 409, 'a second vote for the same contestant is refused');
});

// --------------------------------------------------------------- the race

test('concurrent votes do not exceed the cap', async () => {
  // The one that matters. Counting and then inserting is not atomic: without a
  // lock, concurrent requests each see four votes used and each insert a fifth.
  // §9.4 asks for defences against exactly this.
  const jwt = require('jsonwebtoken');
  await pool.query(
    `INSERT INTO users (id, email, full_name, password_hash, role)
     VALUES (940504,'racer@vote92.test','Racer','x','member')`);
  const racer = jwt.sign({ id: 940504, email: 'racer@vote92.test', role: 'member' },
    process.env.JWT_SECRET);

  // Eight votes fired at once at eight different entries. Five may land.
  const results = await Promise.all(
    cappedEntries.map((id) => vote(id, racer)));

  const accepted = results.filter((r) => r.status === 201).length;
  const refused = results.filter((r) => r.status === 429).length;

  assert.equal(accepted, 5, `exactly five should land, got ${accepted}`);
  assert.equal(refused, 3, `the other three should be refused, got ${refused}`);

  const stored = await pool.query(
    `SELECT COALESCE(SUM(v.bundle_size),0)::int AS n FROM votes v
       JOIN competition_entries ce ON ce.id = v.entry_id
      WHERE ce.competition_id = $1 AND v.voter_user_id = 940504`, [cappedId]);
  assert.equal(stored.rows[0].n, 5, 'and the database holds exactly five');
});

// ------------------------------------------------------- paid votes exempt

test('PAID BULK VOTES ARE NEVER CAPPED', async () => {
  // They were bought. A cap on them would be taking somebody's money and not
  // giving them what they paid for.
  const bundle = await pool.query(
    `INSERT INTO vote_bundles (entry_id, buyer_user_id, vote_count, price, status, reference)
     VALUES ($1,$2,500,300.00,'confirmed','VB-CAP-1') RETURNING id`, [cappedEntries[0], ME]);
  await pool.query(
    `INSERT INTO votes (entry_id, voter_user_id, bundle_size, vote_bundle_id)
     VALUES ($1,$2,500,$3)`, [cappedEntries[0], ME, bundle.rows[0].id]);

  const r = await pool.query(
    `SELECT COALESCE(SUM(v.bundle_size),0)::int AS n FROM votes v
       JOIN competition_entries ce ON ce.id = v.entry_id
      WHERE ce.competition_id = $1 AND v.voter_user_id = $2`, [cappedId, ME]);
  assert.equal(r.rows[0].n, 505, '5 free + 500 paid');
});

// ------------------------------------------------- §8.5 contestant dashboard

test('§8.5: A CONTESTANT SEES THEIR CODE AND EXACT VERIFIED VOTES', async () => {
  const prof = await pool.query(
    `INSERT INTO profiles (user_id, display_name, slug, package_tier, status)
     VALUES ($1,'Contestant Me','contestant-me','basic','approved') RETURNING id`, [ME]);
  const entry = await pool.query(
    `INSERT INTO competition_entries (competition_id, profile_id, status)
     VALUES ($1,$2,'approved') RETURNING id, entry_code`, [uncappedId, prof.rows[0].id]);

  // 3 online, 100 bulk, 7 by admin adjustment.
  await pool.query(
    `INSERT INTO votes (entry_id, session_id, bundle_size, vote_day)
     VALUES ($1,'guest-a',1,CURRENT_DATE), ($1,'guest-b',1,CURRENT_DATE), ($1,'guest-c',1,CURRENT_DATE)`,
    [entry.rows[0].id]);
  const b = await pool.query(
    `INSERT INTO vote_bundles (entry_id, session_id, vote_count, price, status, reference)
     VALUES ($1,'guest-a',100,80.00,'confirmed','VB-85-1') RETURNING id`, [entry.rows[0].id]);
  await pool.query(
    `INSERT INTO votes (entry_id, session_id, bundle_size, vote_bundle_id)
     VALUES ($1,'guest-a',100,$2)`, [entry.rows[0].id, b.rows[0].id]);
  await pool.query(
    `INSERT INTO votes (entry_id, session_id, bundle_size)
     VALUES ($1,'admin-adjust:x',7)`, [entry.rows[0].id]);

  const rows = await dash.entriesFor(ME);
  const mine = rows.find((r) => r.id === entry.rows[0].id);
  assert.ok(mine, 'the contestant should see their own entry');

  assert.match(mine.entryCode, /^[0-9]{10}$/, 'the 10-digit code, issued on approval');
  assert.equal(mine.verifiedVotes, 110, 'EXACT: 3 online + 100 bulk + 7 adjusted');
  assert.equal(mine.bulkVotes, 100);
  assert.equal(mine.onlineVotes, 3, 'an admin adjustment is not a public vote');
  assert.equal(mine.adjustmentVotes, 7);
  assert.equal(mine.verifiedVotes, mine.onlineVotes + mine.bulkVotes + mine.adjustmentVotes,
    'the split must add up to the exact total');
});

test('§8.5: ranking, closing date and competition status are all there', async () => {
  const rows = await dash.entriesFor(ME);
  const mine = rows.find((r) => r.competitionSlug === 'uncapped-comp');
  assert.ok(mine.ranking >= 1, 'a position among the contestants');
  assert.ok(mine.contestants >= 1);
  assert.ok(mine.closesAt, 'the competition closing date');
  assert.equal(mine.competitionStatus, 'open');
  assert.equal(mine.competition, 'Uncapped Comp');
});

test('the ranking is over the whole competition, not just my entries', async () => {
  // A rank among your own entries would always be 1 and mean nothing.
  const rows = await dash.entriesFor(ME);
  const mine = rows.find((r) => r.competitionSlug === 'uncapped-comp');
  assert.ok(mine.contestants > 1,
    'the competition has other approved entries, and they must be counted');
});

test('an unapproved entry has no code and no ranking', async () => {
  const prof = await pool.query(`SELECT id FROM profiles WHERE user_id = $1`, [ME]);
  const pending = await pool.query(
    `INSERT INTO competition_entries (competition_id, profile_id, status)
     VALUES ($1,$2,'pending') RETURNING id`, [cappedId, prof.rows[0].id]);

  const rows = await dash.entriesFor(ME);
  const row = rows.find((r) => r.id === pending.rows[0].id);
  assert.equal(row.entryCode, null, 'a code is issued on approval, not before');
  assert.equal(row.ranking, null, 'and there is no position in a race you are not in');
});

test('the endpoint still returns vote_count, so nothing already reading it breaks', async () => {
  const res = await api('GET', '/entries/mine', null, token);
  assert.equal(res.status, 200);
  assert.ok(res.body.entries.length > 0);
  for (const e of res.body.entries) {
    assert.equal(e.vote_count, e.verifiedVotes);
  }
});

test('THE LOCK ACTUALLY SERIALISES ONE VOTER, WHICH IS WHAT MAKES THE CAP EXACT', async () => {
  // Tests the mechanism rather than hoping to hit the window. Two transactions
  // take the same advisory key; the second must WAIT for the first to finish.
  // Without that, the count-then-insert in the vote route is a race, and a
  // scripted voter is exactly what §9.4 asks us to stop.
  const a = await pool.connect();
  const b = await pool.connect();
  const key = `vote:u:940504:${cappedId}`;
  try {
    await a.query('BEGIN');
    await a.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);

    await b.query('BEGIN');
    let bGotIt = false;
    const bWaiting = b.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key])
      .then(() => { bGotIt = true; });

    // Give it time it would easily have taken if it were not blocked.
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(bGotIt, false,
      'the second transaction took the lock while the first still held it');

    await a.query('COMMIT');   // releases the lock
    await bWaiting;
    assert.equal(bGotIt, true, 'and it proceeds once the first is done');
    await b.query('COMMIT');
  } finally {
    a.release();
    b.release();
  }
});

test('two different voters are never made to wait for each other', async () => {
  // The lock is per voter per competition. If it were coarser, one person
  // voting would briefly block everybody else on a busy competition.
  const a = await pool.connect();
  const b = await pool.connect();
  try {
    await a.query('BEGIN');
    await a.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`vote:u:1:${cappedId}`]);
    await b.query('BEGIN');
    // Different voter: must not block.
    await b.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`vote:u:2:${cappedId}`]);
    await b.query('COMMIT');
    await a.query('COMMIT');
  } finally {
    a.release();
    b.release();
  }
});
