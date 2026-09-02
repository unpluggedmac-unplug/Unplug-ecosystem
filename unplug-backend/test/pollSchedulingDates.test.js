// Poll scheduling compares dates as TEXT, and depends on being given text.
//
// votingOpen() compares the schedule against the database's own today:
//
//   if (row.starts_at && String(row.starts_at) > today) return false;
//   if (row.ends_at   && String(row.ends_at)   < today) return false;
//
// Handed a Date OBJECT rather than text, String() would produce
//
//   "Sat Oct 31 2026 00:00:00 GMT+0200 (South Africa Standard Time)"
//
// and comparing that with "2026-10-31" is a lexicographic 'S' > '2' — true for
// every date there has ever been. Every poll with a start date would be closed
// to voting, and no poll would ever close on its end date.
//
// polls.js is protected from that TWICE, and either alone is enough:
//
//   1. every one of its queries selects `to_char(starts_at, 'YYYY-MM-DD')`, and
//   2. src/pgTypes.js now returns every DATE as that same text anyway.
//
// It has always had (1), so poll scheduling was never actually broken — checked
// by removing each protection in turn: with either one present these pass, and
// only with BOTH removed do four of them fail.
//
// The point of keeping them: the casts read like formatting for display, but
// they are load-bearing arithmetic, and nothing in the file said so. Poll
// scheduling had no direct coverage at all before this.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const EmbeddedPostgres = require('embedded-postgres').default;
const { stopPostgres } = require('./helpers/stopPostgres');
const { ensureStopWords } = require('./helpers/textSearch');

require('../src/pgTypes');

let pg;
let pool;
let server;
let baseUrl;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-pollsched-'));
const port = 50000 + (process.pid % 300);

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
  process.env.JWT_SECRET = 'test-secret-poll-sched';
  process.env.UNPLUG_DISABLE_RATE_LIMITS = '1';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(dir, f), 'utf8'));
  }

  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/polls', require('../src/routes/polls'));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
});

async function makePoll(question, startOffset, endOffset) {
  const r = await pool.query(
    `INSERT INTO polls (question, is_open, starts_at, ends_at)
     VALUES ($1, TRUE,
             ${startOffset === null ? 'NULL' : `(CURRENT_DATE + ${startOffset})`},
             ${endOffset === null ? 'NULL' : `(CURRENT_DATE + ${endOffset})`})
     RETURNING id`,
    [question]
  );
  return r.rows[0].id;
}

const stateOf = async (id) => {
  const res = await fetch(`${baseUrl}/polls/${id}`);
  if (!res.ok) return { httpStatus: res.status };
  return res.json();
};

test('A RUNNING POLL WITH A START DATE ACCEPTS VOTES', async () => {
  // The bug, stated directly: this poll started yesterday, ends tomorrow, and
  // was reported closed for no reason a reader could see.
  const id = await makePoll('Which story moved you most?', -1, 1);
  const body = await stateOf(id);
  assert.equal(body.poll ? body.poll.votingOpen : body.votingOpen, true,
    'a poll inside its own schedule must be open');
});

test('a poll whose start date has not arrived is closed, and says so', async () => {
  const id = await makePoll('Not yet', 5, 10);
  const body = await stateOf(id);
  const poll = body.poll || body;
  assert.equal(poll.votingOpen, false);
  assert.equal(poll.closedReason, 'not_started',
    'the reason must be "not_started", not "ended" — the poll has not run yet');
});

test('A POLL CLOSES ON ITS END DATE', async () => {
  // The other half: the end check could never fire either.
  const id = await makePoll('Long over', -30, -10);
  const body = await stateOf(id);
  const poll = body.poll || body;
  assert.equal(poll.votingOpen, false);
  assert.equal(poll.closedReason, 'ended');
});

test('ends_at is inclusive — a poll ending TODAY still takes votes', async () => {
  // Documented behaviour in polls.js: a poll ending on the 7th takes votes all
  // day on the 7th.
  const id = await makePoll('Closing today', -3, 0);
  const body = await stateOf(id);
  const poll = body.poll || body;
  assert.equal(poll.votingOpen, true, 'the last day counts');
});

test('starts_at is inclusive — a poll starting TODAY takes votes', async () => {
  const id = await makePoll('Opening today', 0, 5);
  const body = await stateOf(id);
  const poll = body.poll || body;
  assert.equal(poll.votingOpen, true);
});

test('a poll with no schedule at all is unaffected', async () => {
  // Polls predating the schedule columns have both NULL, and must behave
  // exactly as they always did.
  const id = await makePoll('No schedule', null, null);
  const body = await stateOf(id);
  const poll = body.poll || body;
  assert.equal(poll.votingOpen, true);
});

test('the admin switch still overrides the schedule', async () => {
  // is_open is the admin's hand switch: a poll closed early stays closed even
  // though its end date is still in the future.
  const id = await makePoll('Closed by hand', -1, 30);
  await pool.query(`UPDATE polls SET is_open = FALSE WHERE id = $1`, [id]);
  const body = await stateOf(id);
  const poll = body.poll || body;
  assert.equal(poll.votingOpen, false);
  assert.equal(poll.closedReason, 'closed');
});
