// TOP 10 MONTHLY RANKINGS — month-end capture, reset, and carried placings.
//
// The guarantees worth testing hardest, in order of what would hurt most:
//
//   1. PAID VOTES ARE NEVER DELETED. Vote rows carry payment_id and
//      vote_bundle_id — they are the record of what someone bought. The reset
//      must be a change of period, not a deletion. If this test ever fails,
//      the site has lost the ability to answer "what did I pay for?".
//   2. The new month starts everyone on ZERO but IN THE CLOSING ORDER, and a
//      single real vote outranks any carried position. That is the whole
//      brief: "restart at zero points but remain in their position, when
//      users votes for them in the new month, the board adjust".
//   3. The archive holds the FULL list, #1 to the last spot — not the top ten.
//   4. The archive survives the entry being deleted afterwards.
//   5. Capturing twice does not double-record or double-award.
//   6. The Arena is NOT reset — only the Top 10 is a monthly title.
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
let capture; // src/utils/top10MonthlyCapture
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-t10arch-'));
const port = 27200 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

async function req(method, urlPath, { token, body } = {}) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, body: json };
}

let jwt;
function tokenFor(userId, role = 'member') {
  return jwt.sign({ id: userId, email: `ta${userId}@test.com`, role }, process.env.JWT_SECRET);
}

let _nextUserId = 181000;
let _nextSlug = 0;

async function makeUser() {
  const id = _nextUserId++;
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', 'member')
     ON CONFLICT DO NOTHING`,
    [id, `ta${id}@test.com`]
  );
  return id;
}

// An approved contestant in the given competition. createdAt is backdated in
// tests that capture a month in the past — a contestant who entered in August
// was not on April's board, and the capture is right to leave them off it.
async function makeEntry(competitionId, name, createdAt = null) {
  const userId = await makeUser();
  const p = await pool.query(
    `INSERT INTO profiles (user_id, type, package_tier, slug, display_name, status)
     VALUES ($1, 'individual', 'basic', $2, $3, 'approved') RETURNING id`,
    [userId, `t10-arch-${_nextSlug++}`, name]
  );
  const e = await pool.query(
    `INSERT INTO competition_entries (competition_id, profile_id, status, created_at)
     VALUES ($1, $2, 'approved', COALESCE($3::timestamptz, now())) RETURNING id`,
    [competitionId, p.rows[0].id, createdAt]
  );
  return { userId, profileId: p.rows[0].id, entryId: e.rows[0].id, name };
}

// How many contestants were eligible for a given month — the number the
// capture should archive. Used instead of a hardcoded count because these
// tests share one Top 10 competition, so entries accumulate across them.
async function eligibleCount(competitionId, period) {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM competition_entries
      WHERE competition_id = $1 AND status = 'approved'
        AND created_at < ($2::date + INTERVAL '1 month')`,
    [competitionId, period]
  );
  return r.rows[0].n;
}

let _voteSeq = 0;
// A vote belonging to a specific month. Distinct session ids because the
// uniqueness indexes allow one free vote per session per entry.
async function addVotes(entryId, count, period, opts = {}) {
  const r = await pool.query(
    `INSERT INTO votes (entry_id, session_id, bundle_size, vote_period, payment_id, vote_bundle_id)
     VALUES ($1, $2, $3, $4::date, $5, $6) RETURNING id`,
    [entryId, `arch-sess-${_voteSeq++}`, count, period, opts.paymentId || null, opts.bundleId || null]
  );
  return r.rows[0].id;
}

const PERIOD = (y, m) => `${y}-${String(m).padStart(2, '0')}-01`;

async function thisMonth() {
  const r = await pool.query(
    `SELECT EXTRACT(YEAR FROM d)::int AS year, EXTRACT(MONTH FROM d)::int AS month,
            to_char(d, 'YYYY-MM-DD') AS period
       FROM (SELECT date_trunc('month', (now() AT TIME ZONE 'Africa/Johannesburg')) AS d) t`
  );
  return r.rows[0];
}

async function badgesHeldBy(userId) {
  const r = await pool.query(
    `SELECT badge_code, award_month, award_year FROM user_badges
      WHERE user_id = $1 ORDER BY badge_code`, [userId]
  );
  return r.rows;
}

let adminToken;
let adminId;
let top10Id;
let arenaId;

before(async () => {
  pg = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'postgres', password: 'postgres', port,
    persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('unplug_test');

  process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${port}/unplug_test`;
  process.env.JWT_SECRET = 'test-secret-for-top10-archive';
  process.env.UNPLUG_DISABLE_RATE_LIMITS = '1';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }

  jwt = require('jsonwebtoken');
  capture = require('../src/utils/top10MonthlyCapture');

  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/', require('../src/routes/competitions'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  adminId = await makeUser();
  await pool.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [adminId]);
  adminToken = tokenFor(adminId, 'admin');

  // The two built-in competitions. Only the Top 10 resets monthly.
  const t = await pool.query(
    `INSERT INTO competitions (name, slug, opens_at, closes_at, status)
     VALUES ('Top 10', 'top-10', now() - interval '1 year', now() + interval '1 year', 'open')
     ON CONFLICT (slug) DO UPDATE SET status = 'open' RETURNING id`
  );
  top10Id = t.rows[0].id;
  const a = await pool.query(
    `INSERT INTO competitions (name, slug, opens_at, closes_at, status)
     VALUES ('The Arena', 'the-arena', now() - interval '1 year', now() + interval '1 year', 'open')
     ON CONFLICT (slug) DO UPDATE SET status = 'open' RETURNING id`
  );
  arenaId = a.rows[0].id;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  if (pg) await pg.stop();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* Windows holds the dir briefly */ }
});

// ---------------------------------------------------------------------------
// The schema change itself
// ---------------------------------------------------------------------------

test('every vote is stamped with a month, and cannot be left unstamped', async () => {
  const col = await pool.query(
    `SELECT is_nullable, column_default FROM information_schema.columns
      WHERE table_name = 'votes' AND column_name = 'vote_period'`
  );
  assert.equal(col.rows[0].is_nullable, 'NO', 'a vote belonging to no month would be invisible on every board');
  assert.match(col.rows[0].column_default, /Africa\/Johannesburg/,
    'the month must roll over at South African midnight, not UTC');
});

test('a vote inserted without a period lands in the current month', async () => {
  // This is what makes all four INSERT sites (free vote, admin adjustment,
  // bundle approval, online paid vote) correct without any of them changing.
  const e = await makeEntry(top10Id, 'Default Period');
  await pool.query(
    `INSERT INTO votes (entry_id, session_id, bundle_size) VALUES ($1, $2, 1)`,
    [e.entryId, `default-period-${_voteSeq++}`]
  );
  const r = await pool.query(
    `SELECT to_char(vote_period, 'YYYY-MM-DD') AS p FROM votes WHERE entry_id = $1`, [e.entryId]);
  const now = await thisMonth();
  assert.equal(r.rows[0].p, now.period);
});

// ---------------------------------------------------------------------------
// THE MONEY GUARANTEE
// ---------------------------------------------------------------------------

test('capturing a month DELETES NO VOTES — paid rows keep their payment link', async () => {
  // If this ever fails, a bulk-vote buyer asking "what did I pay for?" three
  // months later cannot be answered. That is why the reset is a period change
  // rather than a delete.
  const e = await makeEntry(top10Id, 'Paid Contestant', '2026-03-05');

  const buyer = await makeUser();
  const pay = await pool.query(
    `INSERT INTO payments (user_id, amount, method, gateway_reference, status, linked_type, linked_id)
     VALUES ($1, 500, 'eft', $2, 'confirmed', 'competition_entry', $3) RETURNING id`,
    [buyer, `ARCHPAY-${_voteSeq}`, e.entryId]
  );
  const bundle = await pool.query(
    `INSERT INTO vote_bundles (entry_id, buyer_user_id, vote_count, price, reference, status)
     VALUES ($1, $2, 100, 500, $3, 'confirmed') RETURNING id`,
    [e.entryId, buyer, `ARCHTEST${_voteSeq}`]
  );
  const voteId = await addVotes(e.entryId, 100, PERIOD(2026, 3), {
    paymentId: pay.rows[0].id, bundleId: bundle.rows[0].id,
  });

  await capture.captureMonth({ year: 2026, month: 3, adminUserId: adminId, auto: false });

  const after = await pool.query(
    `SELECT bundle_size, payment_id, vote_bundle_id,
            to_char(vote_period, 'YYYY-MM-DD') AS vote_period
       FROM votes WHERE id = $1`, [voteId]
  );
  assert.equal(after.rows.length, 1, 'THE PAID VOTE ROW MUST STILL EXIST AFTER A MONTH IS CAPTURED');
  assert.equal(after.rows[0].bundle_size, 100, 'the number of votes bought must be unchanged');
  assert.equal(after.rows[0].payment_id, pay.rows[0].id, 'the link to the payment must survive');
  assert.equal(after.rows[0].vote_bundle_id, bundle.rows[0].id, 'the link to the bundle must survive');
  assert.equal(after.rows[0].vote_period, '2026-03-01',
    'and it must still belong to the month it was cast in');
});

// ---------------------------------------------------------------------------
// The capture
// ---------------------------------------------------------------------------

let aprilCount = 0; // shared with the admin-surface tests below

test('the archive holds the FULL board, #1 to the last spot', async () => {
  // "capture the full top 10 list ... ranking #1 to the last spot" — with
  // twelve leading contestants, an archive that stopped at ten would be
  // visibly wrong.
  for (let i = 0; i < 12; i++) {
    const e = await makeEntry(top10Id, `Full Board ${i}`, '2026-04-05');
    await addVotes(e.entryId, 100 - i, PERIOD(2026, 4)); // strictly descending
  }

  const expected = await eligibleCount(top10Id, PERIOD(2026, 4));
  assert.ok(expected > 10, 'the point of this test is a board longer than ten');

  const result = await capture.captureMonth({ year: 2026, month: 4, adminUserId: adminId, auto: false });
  assert.equal(result.captured, true);
  assert.equal(result.entryCount, expected, 'every contestant is recorded, not just the top ten');
  aprilCount = expected;

  const rows = await pool.query(
    `SELECT rank, display_name, vote_count FROM top10_monthly_rankings
      WHERE period_year = 2026 AND period_month = 4 ORDER BY rank`
  );
  assert.equal(rows.rows.length, expected);
  // Ranks run 1..n with no gaps — the last spot is ranked, not dropped.
  assert.deepEqual(rows.rows.map((r) => r.rank),
    Array.from({ length: expected }, (_, i) => i + 1));
  // The twelve with votes hold the top twelve places, in vote order.
  assert.deepEqual(rows.rows.slice(0, 12).map((r) => r.display_name),
    Array.from({ length: 12 }, (_, i) => `Full Board ${i}`));
  assert.equal(rows.rows[0].vote_count, 100);
});

test('a captured month is not captured again', async () => {
  const again = await capture.captureMonth({ year: 2026, month: 4, adminUserId: adminId, auto: false });
  assert.equal(again.captured, false);
  assert.equal(again.reason, 'already-captured');

  const rows = await pool.query(
    `SELECT COUNT(*)::int AS n FROM top10_monthly_rankings WHERE period_year = 2026 AND period_month = 4`
  );
  assert.equal(rows.rows[0].n, aprilCount, 'a second run must not stack a second set of positions');
});

test('a month with no contestants still counts as captured', async () => {
  // Otherwise the hourly job retries that month for ever.
  const r = await capture.captureMonth({ year: 2019, month: 7, adminUserId: adminId, auto: false });
  assert.equal(r.captured, true);
  assert.equal(r.entryCount, 0);

  const again = await capture.captureMonth({ year: 2019, month: 7, auto: true });
  assert.equal(again.reason, 'already-captured');
});

// ---------------------------------------------------------------------------
// THE RESET AND THE CARRIED PLACINGS — the heart of the brief
// ---------------------------------------------------------------------------

test('after capture the new month reads ZERO but keeps the closing order', async () => {
  // Uses the real Top 10 so the public route applies the monthly rule.
  const winner = await makeEntry(top10Id, 'Reset Winner', '2026-05-02');
  const second = await makeEntry(top10Id, 'Reset Second', '2026-05-02');
  const third = await makeEntry(top10Id, 'Reset Third', '2026-05-02');

  const last = PERIOD(2026, 5);
  await addVotes(winner.entryId, 900, last);
  await addVotes(second.entryId, 800, last);
  await addVotes(third.entryId, 700, last);

  await capture.captureMonth({ year: 2026, month: 5, adminUserId: adminId, auto: false });

  // carried_rank is now set from where they finished.
  const carried = await pool.query(
    'SELECT id, carried_rank FROM competition_entries WHERE id = ANY($1) ORDER BY carried_rank',
    [[winner.entryId, second.entryId, third.entryId]]
  );
  assert.deepEqual(carried.rows.map((r) => r.id), [winner.entryId, second.entryId, third.entryId]);

  // The live board: May's votes belong to May, so the current month is zero.
  const board = await req('GET', '/competitions/top-10');
  assert.equal(board.status, 200);
  assert.equal(board.body.monthlyReset, true);

  const three = board.body.entries.filter((e) =>
    [winner.entryId, second.entryId, third.entryId].includes(e.id));
  assert.deepEqual(three.map((e) => e.vote_count), [0, 0, 0],
    'the new month must start every contestant back at zero');
  assert.deepEqual(three.map((e) => e.display_name),
    ['Reset Winner', 'Reset Second', 'Reset Third'],
    'but they must stay in the order the previous month closed in');
});

test('ONE vote in the new month outranks last month\'s champion', async () => {
  // The other half of the brief: "when users votes for them in the new month,
  // the board adjust with the new placings". A carried position is a
  // tie-breaker, never a head start.
  const champ = await makeEntry(top10Id, 'Carried Champion', '2026-06-02');
  const challenger = await makeEntry(top10Id, 'New Challenger', '2026-06-02');

  await addVotes(champ.entryId, 5000, PERIOD(2026, 6));
  await addVotes(challenger.entryId, 1, PERIOD(2026, 6));
  await capture.captureMonth({ year: 2026, month: 6, adminUserId: adminId, auto: false });

  // Champion carries rank 1, challenger rank 2 — before anyone votes.
  let board = await req('GET', '/competitions/top-10');
  let pair = board.body.entries.filter((e) => [champ.entryId, challenger.entryId].includes(e.id));
  assert.deepEqual(pair.map((e) => e.display_name), ['Carried Champion', 'New Challenger']);

  // The challenger picks up a single vote THIS month.
  const now = await thisMonth();
  await addVotes(challenger.entryId, 1, now.period);

  board = await req('GET', '/competitions/top-10');
  pair = board.body.entries.filter((e) => [champ.entryId, challenger.entryId].includes(e.id));
  assert.deepEqual(pair.map((e) => e.display_name), ['New Challenger', 'Carried Champion'],
    'a single real vote must beat a carried position — 5000 votes last month is not a head start');
  assert.equal(pair[0].vote_count, 1);
  assert.equal(pair[1].vote_count, 0);
});

test('the board sends carried_rank to the page, so it cannot re-sort wrongly', async () => {
  // The Top 10 page re-ranks client-side. If carried_rank were not sent, the
  // page would fall back to "who entered first" on the 1st of the month and
  // silently reorder the board after it loaded.
  const board = await req('GET', '/competitions/top-10');
  const withRank = board.body.entries.filter((e) => e.carried_rank != null);
  assert.ok(withRank.length > 0, 'captured entries must carry their position to the frontend');
});

test('the vote-buying portal shows the SAME number as the public board', async () => {
  // A buyer seeing "5,000 votes so far" beside a board reading 0 would think
  // one of the two is broken — and this is the screen where money is spent.
  const e = await makeEntry(top10Id, 'Portal Consistency', '2026-06-02');
  await addVotes(e.entryId, 4321, PERIOD(2026, 6)); // a closed month
  const now = await thisMonth();
  await addVotes(e.entryId, 7, now.period); // this month

  const search = await req('GET', '/entries/search?q=Portal%20Consistency&competitionSlug=top-10');
  assert.equal(search.status, 200);
  const found = search.body.entries.find((x) => x.id === e.entryId);
  assert.ok(found, 'the contestant must be findable in the buying portal');
  assert.equal(found.vote_count, 7,
    'the portal must show this month\'s votes, matching the board — not the all-time total');

  const board = await req('GET', '/competitions/top-10');
  const onBoard = board.body.entries.find((x) => x.id === e.entryId);
  assert.equal(onBoard.vote_count, found.vote_count, 'the two screens must never disagree');
});

test('The Arena is NOT reset monthly — its running total stands', async () => {
  const fighter = await makeEntry(arenaId, 'Arena Fighter');
  await addVotes(fighter.entryId, 40, PERIOD(2026, 1));
  await addVotes(fighter.entryId, 60, PERIOD(2026, 2));

  const board = await req('GET', '/competitions/the-arena');
  assert.equal(board.status, 200);
  assert.equal(board.body.monthlyReset, false);
  const row = board.body.entries.find((e) => e.id === fighter.entryId);
  assert.equal(row.vote_count, 100,
    'a competition that runs to its own dates must keep counting every vote');
});

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

test('the capture awards the three placement badges, top three only', async () => {
  const first = await makeEntry(top10Id, 'Badge First', '2025-09-02');
  const second = await makeEntry(top10Id, 'Badge Second', '2025-09-02');
  const third = await makeEntry(top10Id, 'Badge Third', '2025-09-02');
  const fourth = await makeEntry(top10Id, 'Badge Fourth', '2025-09-02');

  const p = PERIOD(2025, 9);
  await addVotes(first.entryId, 400, p);
  await addVotes(second.entryId, 300, p);
  await addVotes(third.entryId, 200, p);
  await addVotes(fourth.entryId, 100, p);

  const r = await capture.captureMonth({ year: 2025, month: 9, adminUserId: adminId, auto: false });
  assert.equal(r.awardedBadges.length, 3);

  assert.deepEqual(await badgesHeldBy(first.userId),
    [{ badge_code: 'top10_champion', award_month: 9, award_year: 2025 }]);
  assert.deepEqual(await badgesHeldBy(second.userId),
    [{ badge_code: 'top10_runner_up', award_month: 9, award_year: 2025 }]);
  assert.deepEqual(await badgesHeldBy(third.userId),
    [{ badge_code: 'top10_third_place', award_month: 9, award_year: 2025 }]);
  assert.deepEqual(await badgesHeldBy(fourth.userId), [], 'fourth place earns nothing');
});

test('re-capturing a corrected month MOVES the badge', async () => {
  // Same failure the publish path guards against: two people both holding
  // "Champion — October", visible on both their public profiles.
  const wrong = await makeEntry(top10Id, 'Wrongly First', '2025-10-02');
  const real = await makeEntry(top10Id, 'Really First', '2025-10-02');

  const p = PERIOD(2025, 10);
  await addVotes(wrong.entryId, 100, p);
  await capture.captureMonth({ year: 2025, month: 10, adminUserId: adminId, auto: false });
  assert.equal((await badgesHeldBy(wrong.userId)).length, 1);

  // The correction: the real winner's votes are recorded, and the month is
  // captured again with force.
  await addVotes(real.entryId, 500, p);
  const r = await capture.captureMonth({
    year: 2025, month: 10, adminUserId: adminId, auto: false, force: true,
  });
  assert.equal(r.captured, true);

  // The champion badge MOVES. The previously-wrong winner is now second, so
  // they correctly hold runner-up instead — what must never happen is them
  // keeping Champion alongside the real winner.
  assert.deepEqual(await badgesHeldBy(real.userId),
    [{ badge_code: 'top10_champion', award_month: 10, award_year: 2025 }]);
  assert.deepEqual(await badgesHeldBy(wrong.userId),
    [{ badge_code: 'top10_runner_up', award_month: 10, award_year: 2025 }],
    'the previous winner drops to the badge their corrected position earns');

  const champions = await pool.query(
    `SELECT COUNT(*)::int AS n FROM user_badges
      WHERE badge_code = 'top10_champion' AND award_month = 10 AND award_year = 2025`
  );
  assert.equal(champions.rows[0].n, 1,
    'ONE champion per month — two profiles both showing "Champion — October 2025" is the failure this guards');

  const expected = await eligibleCount(top10Id, PERIOD(2025, 10));
  const rows = await pool.query(
    `SELECT COUNT(*)::int AS n FROM top10_monthly_rankings WHERE period_year = 2025 AND period_month = 10`
  );
  assert.equal(rows.rows[0].n, expected,
    'a forced re-capture replaces the month rather than appending to it');
});

// ---------------------------------------------------------------------------
// The archive as a permanent record
// ---------------------------------------------------------------------------

test('the archive survives the contestant being deleted afterwards', async () => {
  const doomed = await makeEntry(top10Id, 'Since Deleted', '2025-11-02');
  await addVotes(doomed.entryId, 250, PERIOD(2025, 11));
  await capture.captureMonth({ year: 2025, month: 11, adminUserId: adminId, auto: false });

  await pool.query('DELETE FROM profiles WHERE id = $1', [doomed.profileId]);

  const r = await pool.query(
    `SELECT display_name, vote_count, entry_id, profile_id FROM top10_monthly_rankings
      WHERE period_year = 2025 AND period_month = 11 AND display_name = 'Since Deleted'`
  );
  assert.equal(r.rows.length, 1, 'a record of who placed where must not vanish when a profile is tidied up');
  assert.equal(r.rows[0].display_name, 'Since Deleted');
  assert.equal(r.rows[0].vote_count, 250);
  assert.equal(r.rows[0].entry_id, null, 'the dead reference is cleared, the record is not');
  assert.equal(r.rows[0].profile_id, null);
});

// ---------------------------------------------------------------------------
// The admin surface
// ---------------------------------------------------------------------------

test('the months list shows each captured month with its winner', async () => {
  const res = await req('GET', '/top10/monthly-rankings', { token: adminToken });
  assert.equal(res.status, 200);

  const april = res.body.months.find((m) => m.period_year === 2026 && m.period_month === 4);
  assert.ok(april, 'April 2026 was captured and must be listed');
  assert.equal(april.entry_count, aprilCount);
  assert.equal(april.winner_name, 'Full Board 0');
  assert.equal(april.period_label, 'April 2026');

  // Newest first, so the most recent month is the one an admin lands on.
  const ordered = res.body.months.map((m) => m.period_year * 100 + m.period_month);
  assert.deepEqual(ordered, [...ordered].sort((a, b) => b - a));
});

test('one month returns its full board in rank order', async () => {
  const res = await req('GET', '/top10/monthly-rankings/2026/4', { token: adminToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.month.period_label, 'April 2026');
  assert.equal(res.body.rankings.length, aprilCount);
  assert.deepEqual(res.body.rankings.map((r) => r.rank),
    Array.from({ length: aprilCount }, (_, i) => i + 1));
  assert.equal(res.body.rankings[0].vote_count, 100);
});

test('an uncaptured month is a clean 404, not an empty board', async () => {
  const res = await req('GET', '/top10/monthly-rankings/2030/2', { token: adminToken });
  assert.equal(res.status, 404);
});

test('capturing by hand refuses a month that has not happened yet', async () => {
  const now = await thisMonth();
  const res = await req('POST', '/top10/capture-month', {
    token: adminToken, body: { year: now.year + 1, month: 12 },
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /has not happened yet/);
});

test('capturing an already-captured month is refused with an explanation', async () => {
  const res = await req('POST', '/top10/capture-month', {
    token: adminToken, body: { year: 2026, month: 4 },
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.alreadyCaptured, true);
  assert.match(res.body.error, /already captured/);
});

test('the monthly rankings are admin-only', async () => {
  const memberToken = tokenFor(await makeUser(), 'member');
  for (const [method, url] of [
    ['GET', '/top10/monthly-rankings'],
    ['GET', '/top10/monthly-rankings/2026/4'],
    ['POST', '/top10/capture-month'],
  ]) {
    assert.equal((await req(method, url)).status, 401, `${method} ${url} without a token`);
    assert.equal((await req(method, url, { token: memberToken })).status, 403, `${method} ${url} as a member`);
  }
});

test('re-running every migration is idempotent', async () => {
  const before = await pool.query('SELECT COUNT(*)::int AS n FROM top10_monthly_rankings');
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }
  const after = await pool.query('SELECT COUNT(*)::int AS n FROM top10_monthly_rankings');
  assert.equal(after.rows[0].n, before.rows[0].n, 'a re-deploy must not disturb the archive');

  // And the backfill must not have re-stamped votes that already had a period.
  const stray = await pool.query(
    `SELECT COUNT(*)::int AS n FROM votes WHERE vote_period = $1::date`, [PERIOD(2026, 3)]
  );
  assert.ok(stray.rows[0].n > 0, 'historical votes keep the month they were cast in across re-deploys');
});
