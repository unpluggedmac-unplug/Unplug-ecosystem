// Daily voting for the Top 10 (098_daily_voting.sql).
//
// The two things that actually matter and are easy to get wrong:
//   - a voter can vote again on a NEW day, but not twice on the same day;
//   - supported normal votes accumulate across days.
//
// Also guards the blast radius: the Arena must keep its one-vote-per-person
// rule, while retired bulk-voting routes remain unavailable.
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
  // stopPostgres, not pg.stop() directly: on Windows the library's stop
  // can HANG rather than throw, which used to leave the cluster running
  // with no parent and eventually broke a later test file's startup.
  // See test/helpers/stopPostgres.js.
  await stopPostgres(pg, dataDir);
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
// What the public leaderboard reports
// ---------------------------------------------------------------------------

test('the public Top 10 board reports the accumulated multi-day normal-vote total', async () => {
  const entry = await makeApprovedEntry('Leaderboard Check');
  const a = await makeUser();
  const b = await makeUser();

  await req('POST', `/entries/${entry}/vote`, { token: tokenFor(a) });
  await req('POST', `/entries/${entry}/vote`, { token: tokenFor(b) });
  await backdateVotes(entry, 1);
  await req('POST', `/entries/${entry}/vote`, { token: tokenFor(a) });

  const { status, body } = await req('GET', '/competitions/top-10');
  assert.equal(status, 200);
  const found = body.entries.find((e) => e.id === entry);
  assert.ok(found, 'entry missing from the public Top 10 board');
  assert.equal(found.vote_count, 3, '2 votes day one + 1 vote day two');
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


test('retired bulk-voting API routes return 404', async () => {
  const entry = await makeApprovedEntry('Normal Only');
  const voter = await makeUser();
  const admin = await makeUser('admin');
  const checks = [
    await req('GET', '/vote-bundle-tiers'),
    await req('POST', `/entries/${entry}/vote-bundle`, { token: tokenFor(voter), body: { votes: 10 } }),
    await req('GET', '/vote-bundles/status/OLDREFERENCE'),
    await req('PATCH', '/vote-bundles/OLDREFERENCE/proof', { body: { url: 'https://example.test/proof' } }),
    await req('GET', '/admin/vote-bundles', { token: tokenFor(admin, 'admin') }),
  ];
  checks.forEach((res) => assert.equal(res.status, 404));
});
