// Scheduled reader polls, against a REAL PostgreSQL.
//
// A poll can now run between two dates instead of until somebody remembers to
// close it. The things that matter:
//
//   1. THE WINDOW IS ENFORCED ON THE SERVER. The reader's widget disables its
//      buttons when a poll is shut, but a disabled button is a suggestion.
//      This is what actually refuses the vote;
//   2. ends_at is INCLUSIVE. A poll running "until the 7th" takes votes all
//      day on the 7th — anything else quietly gives a day less than promised;
//   3. is_open still wins. Closing a poll early must not be undone by its end
//      date still being in the future;
//   4. a closed poll still RETURNS its results, because the article keeps
//      showing them after voting ends;
//   5. existing polls, which have no dates at all, behave exactly as before.
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
let jwt;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-pollsched-'));
const port = 34000 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

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

function tokenFor(userId, role = 'member') {
  return jwt.sign({ id: userId, email: `pl${userId}@test.com`, role }, process.env.JWT_SECRET);
}

let _nextUserId = 991000;
async function makeUser(role = 'member') {
  const id = _nextUserId++;
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', $3) ON CONFLICT DO NOTHING`,
    [id, `pl${id}@test.com`, role]);
  return id;
}

// Dates relative to today, so these tests do not rot.
function dayOffset(n) {
  const d = new Date(); d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() + n * 86400000).toISOString().slice(0, 10);
}

async function makePoll(over = {}) {
  const r = await req('POST', '/polls', {
    token: adminToken,
    body: { question: 'Best braai meat?', options: ['Boerewors', 'Lamb chop'], ...over },
  });
  assert.equal(r.status, 201, `poll not created: ${r.body && r.body.error}`);
  return r.body.poll;
}

let _voter = 0;
async function vote(pollId, optionId) {
  return req('POST', `/polls/${pollId}/vote`, {
    body: { optionId, voterKey: 'tester-' + (++_voter) },
  });
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
  process.env.JWT_SECRET = 'test-secret-for-poll-schedule';
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
  app.use('/polls', require('../src/routes/polls'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  adminToken = tokenFor(await makeUser('admin'), 'admin');
  memberToken = tokenFor(await makeUser());
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  // Windows can still hold a handle on the data directory when Postgres
  // exits, and embedded-postgres removes that directory as part of
  // stopping. The server is already down by then, so an EBUSY here is
  // the OS being slow to let go, not a failure worth failing the file
  // for — and a teardown that goes red teaches everyone to ignore red.
  try { if (pg) await pg.stop(); } catch (e) { /* see above */ }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* Windows holds the dir briefly */ }
});

// ---------------------------------------------------------------------------
// The window decides whether a vote is accepted
// ---------------------------------------------------------------------------

test('A POLL THAT HAS ENDED REFUSES THE VOTE ON THE SERVER', async () => {
  const poll = await makePoll({ startsAt: dayOffset(-10), endsAt: dayOffset(-1) });
  const r = await vote(poll.id, poll.options[0].id);
  assert.equal(r.status, 409);
  assert.match(r.body.error, /closed/i);

  const stored = await pool.query('SELECT COUNT(*)::int AS n FROM poll_votes WHERE poll_id = $1', [poll.id]);
  assert.equal(stored.rows[0].n, 0, 'nothing was recorded');
});

test('a poll that has not started yet refuses the vote and says so', async () => {
  const poll = await makePoll({ startsAt: dayOffset(3), endsAt: dayOffset(10) });
  const r = await vote(poll.id, poll.options[0].id);
  assert.equal(r.status, 409);
  assert.match(r.body.error, /not opened yet/i,
    'a poll that has not started is a different situation from one that ended');
});

test('THE LAST DAY STILL COUNTS — ends_at is inclusive', async () => {
  // Somebody told a poll runs "until the 7th" and finding it shut on the
  // morning of the 7th has been given a day less than they were promised.
  const poll = await makePoll({ startsAt: dayOffset(-3), endsAt: dayOffset(0) });
  const r = await vote(poll.id, poll.options[0].id);
  assert.equal(r.status, 201, 'a vote on the final day must be accepted');
});

test('the first day counts too — starts_at is inclusive', async () => {
  const poll = await makePoll({ startsAt: dayOffset(0), endsAt: dayOffset(5) });
  const r = await vote(poll.id, poll.options[0].id);
  assert.equal(r.status, 201);
});

test('a poll inside its window accepts votes normally', async () => {
  const poll = await makePoll({ startsAt: dayOffset(-2), endsAt: dayOffset(5) });
  const r = await vote(poll.id, poll.options[0].id);
  assert.equal(r.status, 201);
  assert.equal(r.body.poll.totalVotes, 1);
});

test('CLOSING BY HAND BEATS A FUTURE END DATE', async () => {
  // The dates are a schedule; is_open is the switch. An admin shutting a poll
  // early must not have it reopened by its own end date still being ahead.
  const poll = await makePoll({ startsAt: dayOffset(-1), endsAt: dayOffset(30) });
  await req('PATCH', `/polls/${poll.id}`, { token: adminToken, body: { isOpen: false } });

  const r = await vote(poll.id, poll.options[0].id);
  assert.equal(r.status, 409, 'the manual close wins over the schedule');
});

// ---------------------------------------------------------------------------
// Existing polls keep working
// ---------------------------------------------------------------------------

test('A POLL WITH NO DATES BEHAVES EXACTLY AS BEFORE', async () => {
  // Every poll that already exists has NULL dates. None of them may change
  // behaviour because this shipped.
  const poll = await makePoll();
  assert.equal(poll.starts_at, null);
  assert.equal(poll.ends_at, null);
  assert.equal(poll.votingOpen, true);

  const r = await vote(poll.id, poll.options[0].id);
  assert.equal(r.status, 201, 'an open-ended poll still takes votes');
});

test('a start date with no end runs indefinitely', async () => {
  const poll = await makePoll({ startsAt: dayOffset(-1) });
  const r = await vote(poll.id, poll.options[0].id);
  assert.equal(r.status, 201);
});

// ---------------------------------------------------------------------------
// Results stay visible after the poll ends
// ---------------------------------------------------------------------------

test('A CLOSED POLL STILL RETURNS ITS RESULTS FOR THE ARTICLE TO SHOW', async () => {
  const articleOwner = await makeUser();
  const art = await pool.query(
    `INSERT INTO articles (title, body, author_user_id, status)
     VALUES ('Poll Story', 'body', $1, 'approved') RETURNING id`, [articleOwner]);
  const articleId = art.rows[0].id;

  const poll = await makePoll({ articleId, startsAt: dayOffset(-5), endsAt: dayOffset(5) });
  await vote(poll.id, poll.options[0].id);
  await vote(poll.id, poll.options[0].id);
  await vote(poll.id, poll.options[1].id);

  // End it.
  await req('PATCH', `/polls/${poll.id}`, { token: adminToken, body: { endsAt: dayOffset(-1) } });

  const shown = await req('GET', `/polls/article/${articleId}`);
  assert.equal(shown.status, 200);
  assert.equal(shown.body.poll.votingOpen, false, 'voting is over');
  assert.equal(shown.body.poll.closedReason, 'ended');
  assert.equal(shown.body.poll.totalVotes, 3, 'but the numbers are still there');
  assert.equal(shown.body.poll.options[0].votes, 2);
  assert.equal(shown.body.poll.options[0].percent, 67, 'and the share is worked out for the page');
  assert.equal(shown.body.poll.options[1].percent, 33);
});

test('percentages are computed server-side so two screens cannot disagree', async () => {
  const poll = await makePoll();
  await vote(poll.id, poll.options[0].id);
  const got = await req('GET', `/polls/${poll.id}`);
  assert.equal(got.body.poll.options[0].percent, 100);
  assert.equal(got.body.poll.options[1].percent, 0);
});

test('a poll with no votes reports 0% rather than dividing by zero', async () => {
  const poll = await makePoll();
  const got = await req('GET', `/polls/${poll.id}`);
  assert.equal(got.body.poll.totalVotes, 0);
  assert.ok(got.body.poll.options.every((o) => o.percent === 0));
});

// ---------------------------------------------------------------------------
// Dates the admin supplies
// ---------------------------------------------------------------------------

test('AN END BEFORE THE START IS REFUSED — it would accept no votes at all', async () => {
  // And from the admin list it would look identical to a poll nobody voted in.
  const bad = await req('POST', '/polls', {
    token: adminToken,
    body: { question: 'Backwards', options: ['a', 'b'], startsAt: dayOffset(10), endsAt: dayOffset(2) },
  });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /end date cannot be before/i);
});

test('a malformed date is refused rather than silently stored as no date', async () => {
  for (const value of ['21/08/2026', '2026-8-21', 'next week', '2026-02-31']) {
    const bad = await req('POST', '/polls', {
      token: adminToken, body: { question: 'Bad date', options: ['a', 'b'], endsAt: value },
    });
    assert.equal(bad.status, 400, `${value} should be refused`);
  }
});

test('AN INVALID EDIT DOES NOT GET WRITTEN BEFORE BEING REJECTED', async () => {
  // The check has to happen before the UPDATE. Validating afterwards would
  // save the bad window and then report an error.
  const poll = await makePoll({ startsAt: dayOffset(5), endsAt: dayOffset(10) });
  const bad = await req('PATCH', `/polls/${poll.id}`, {
    token: adminToken, body: { endsAt: dayOffset(1) },   // before the start
  });
  assert.equal(bad.status, 400);

  const row = await pool.query(
    `SELECT to_char(ends_at, 'YYYY-MM-DD') AS ends_at FROM polls WHERE id = $1`, [poll.id]);
  assert.equal(row.rows[0].ends_at, dayOffset(10),
    'the stored end date must be untouched by a rejected edit');
});

test('clearing a date turns a scheduled poll back into an open-ended one', async () => {
  const poll = await makePoll({ startsAt: dayOffset(-1), endsAt: dayOffset(1) });
  const cleared = await req('PATCH', `/polls/${poll.id}`, {
    token: adminToken, body: { endsAt: '' },
  });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.poll.ends_at, null);
});

// ---------------------------------------------------------------------------
// What the admin screen is given
// ---------------------------------------------------------------------------

test('THE ADMIN LIST REPORTS THE REAL STATE, NOT JUST THE FLAG', async () => {
  // A poll flagged open whose end date has passed is not running, and
  // labelling it "Open" would be a lie to whoever is checking.
  const ended = await makePoll({ startsAt: dayOffset(-9), endsAt: dayOffset(-1) });
  const scheduled = await makePoll({ startsAt: dayOffset(4) });
  const running = await makePoll({ startsAt: dayOffset(-1), endsAt: dayOffset(9) });

  const list = await req('GET', '/polls', { token: adminToken });
  const find = (id) => list.body.polls.find((p) => p.id === id);

  assert.equal(find(ended.id).state, 'ended');
  assert.equal(find(ended.id).votingOpen, false);
  assert.equal(find(scheduled.id).state, 'scheduled');
  assert.equal(find(scheduled.id).votingOpen, false);
  assert.equal(find(running.id).state, 'open');
  assert.equal(find(running.id).votingOpen, true);
});

test('the admin list carries the per-option results, not just a total', async () => {
  const poll = await makePoll();
  await vote(poll.id, poll.options[0].id);
  await vote(poll.id, poll.options[1].id);
  await vote(poll.id, poll.options[1].id);

  const list = await req('GET', '/polls', { token: adminToken });
  const row = list.body.polls.find((p) => p.id === poll.id);
  assert.equal(row.total_votes, 3);
  assert.equal(row.options.length, 2);
  assert.equal(row.options[0].votes, 1);
  assert.equal(row.options[1].votes, 2);
  assert.equal(row.options[1].percent, 67);
});

test('only an admin can create, edit or delete a poll', async () => {
  const poll = await makePoll();
  for (const [method, urlPath, body] of [
    ['POST', '/polls', { question: 'q', options: ['a', 'b'] }],
    ['PATCH', `/polls/${poll.id}`, { isOpen: false }],
    ['DELETE', `/polls/${poll.id}`, {}],
  ]) {
    const asMember = await req(method, urlPath, { token: memberToken, body });
    assert.equal(asMember.status, 403, `${method} ${urlPath} must refuse a member`);
    const asAnon = await req(method, urlPath, { body });
    assert.equal(asAnon.status, 401, `${method} ${urlPath} must refuse a stranger`);
  }
});

test('reading a poll stays public — the results are part of the story', async () => {
  const poll = await makePoll();
  const anon = await req('GET', `/polls/${poll.id}`);
  assert.equal(anon.status, 200);
});
