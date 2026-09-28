// My Votes / Competition Activity (spec §4; rules in Module 9).
//
// The interesting constraint here is a privacy one. §9.1 says online voting
// "requires NO account", so a vote carries either a voter_user_id or a
// session_id — and the anonymous ones belong to a browser, not to a person.
//
// What these protect:
//
//   1. Anonymous guest votes remain anonymous.
//   2. One member's voting activity is not exposed to another member.
//   3. Normal vote totals and contestant names remain accurate.

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
let tokenMine;
let tokenOther;
let mv;
let entryProfileId;
let entryManualId;
let competitionId;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-myvotes-'));
const port = 53200 + (process.pid % 300);
const ME = 970501;
const OTHER = 970502;

async function api(urlPath, tok) {
  const res = await fetch(baseUrl + urlPath, {
    headers: tok ? { Authorization: 'Bearer ' + tok } : {},
  });
  return { status: res.status, body: await res.json().catch(() => null) };
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
  process.env.JWT_SECRET = 'test-secret-my-votes';
  process.env.UNPLUG_DISABLE_RATE_LIMITS = '1';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(dir, f), 'utf8'));
  }

  mv = require('../src/utils/myVotes');

  const jwt = require('jsonwebtoken');
  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/my', require('../src/routes/mySubmissions'));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await pool.query(
    `INSERT INTO users (id, email, full_name, password_hash, role)
     VALUES ($1,'me@vote.test','Me','x','member'), ($2,'other@vote.test','Other','x','member')`,
    [ME, OTHER]);
  tokenMine = jwt.sign({ id: ME, email: 'me@vote.test', role: 'member' }, process.env.JWT_SECRET);
  tokenOther = jwt.sign({ id: OTHER, email: 'other@vote.test', role: 'member' }, process.env.JWT_SECRET);

  const comp = await pool.query(
    `INSERT INTO competitions (name, slug, opens_at, closes_at, status)
     VALUES ('Best of 2026','best-2026', now() - interval '1 day', now() + interval '30 days','open')
     RETURNING id`);
  const compId = comp.rows[0].id;
  competitionId = compId;

  // A contestant who is a member's profile...
  const prof = await pool.query(
    `INSERT INTO profiles (user_id, display_name, slug, package_tier, status)
     VALUES ($1,'Naledi Dlamini','naledi','basic','approved') RETURNING id`, [OTHER]);
  const e1 = await pool.query(
    `INSERT INTO competition_entries (competition_id, profile_id, status)
     VALUES ($1,$2,'approved') RETURNING id`, [compId, prof.rows[0].id]);
  entryProfileId = e1.rows[0].id;

  // ...and one an admin typed in by hand, with no profile behind it.
  const e2 = await pool.query(
    `INSERT INTO competition_entries (competition_id, manual_name, status)
     VALUES ($1,'Sipho the Baker','approved') RETURNING id`, [compId]);
  entryManualId = e2.rows[0].id;

  // My votes: one ordinary, one from a bundle.
  await pool.query(
    `INSERT INTO votes (entry_id, voter_user_id, bundle_size)
     VALUES ($1,$2,1), ($3,$2,1)`, [entryProfileId, ME, entryManualId]);

  // A GUEST vote — nobody's, and must stay that way.
  await pool.query(
    `INSERT INTO votes (entry_id, session_id, bundle_size)
     VALUES ($1,'guest-session-abc',1)`, [entryProfileId]);

  // Another member's vote.
  await pool.query(
    `INSERT INTO votes (entry_id, voter_user_id, bundle_size)
     VALUES ($1,$2,1)`, [entryManualId, OTHER]);

});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
});

// -------------------------------------------------------------- anonymity

test('ANONYMOUS VOTES STAY ANONYMOUS', async () => {
  const res = await api('/my/votes', tokenMine);
  assert.equal(res.status, 200);
  assert.equal(res.body.votes.length, 2, 'only my own signed-in votes');
  assert.ok(!res.body.votes.some((v) => v.id === 'guest-session-abc'));
});

test('ONE MEMBER\'S ACTIVITY IS NOT ANOTHER\'S', async () => {
  // Who someone voted for is not public.
  const res = await api('/my/votes', tokenOther);
  assert.equal(res.body.votes.length, 1);
});

test('signed out sees nothing', async () => {
  assert.equal((await api('/my/votes', null)).status, 401);
});

test('a member who has never voted gets empty lists and zero totals', async () => {
  const jwt = require('jsonwebtoken');
  await pool.query(
    `INSERT INTO users (id, email, full_name, password_hash, role)
     VALUES (970503,'quiet@vote.test','Quiet','x','member')`);
  const token = jwt.sign({ id: 970503, email: 'quiet@vote.test', role: 'member' },
    process.env.JWT_SECRET);
  const res = await api('/my/votes', token);
  assert.deepEqual(res.body.votes, []);
  assert.equal(res.body.totalVotes, 0);
});

// ----------------------------------------------------------------- totals

test('TOTAL VOTES MATCH THE MEMBER\'S NORMAL VOTE ROWS', async () => {
  const extra = await pool.query(
    `INSERT INTO competition_entries (competition_id, manual_name, status)
     VALUES ($1,'Third Favourite','approved') RETURNING id`, [competitionId]);
  await pool.query(
    `INSERT INTO votes (entry_id, voter_user_id, bundle_size)
     VALUES ($1,$2,1)`, [extra.rows[0].id, ME]);

  const res = await api('/my/votes', tokenMine);
  assert.equal(res.body.votes.length, 3);
  assert.equal(res.body.totalVotes, 3);
});

// ------------------------------------------------------------- the names

test('A CONTESTANT ALWAYS HAS A NAME', async () => {
  // An entry is either a member's profile or an admin-typed manual entry. Both
  // must resolve, or a row renders blank and looks broken.
  const res = await api('/my/votes', tokenMine);
  const names = res.body.votes.map((v) => v.contestant);
  assert.ok(names.includes('Naledi Dlamini'), 'the profile-backed contestant');
  assert.ok(names.includes('Sipho the Baker'), 'the manual one');
  assert.ok(names.every((n) => n && n.trim().length > 0));
});

test('each vote says which competition it was in', async () => {
  const res = await api('/my/votes', tokenMine);
  // Asserted as a set so a failure prints what was actually there.
  const seen = [...new Set(res.body.votes.map((v) => v.competition))].sort();
  assert.deepEqual(seen, ['Best of 2026'],
    `votes: ${JSON.stringify(res.body.votes.map((v) => [v.contestant, v.competition]))}`);
});

test('newest votes are listed first', async () => {
  const res = await api('/my/votes', tokenMine);
  const voteDates = res.body.votes.map((v) => new Date(v.castAt).getTime());
  assert.deepEqual(voteDates, [...voteDates].sort((a, b) => b - a));
});
