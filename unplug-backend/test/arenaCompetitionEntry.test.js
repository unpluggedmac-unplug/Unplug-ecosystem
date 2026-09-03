// ARENA-002: The Arena was being charged and entered as a Top 10 entry.
//
// No frontend anywhere called the real POST /competitions/:id/entries route
// — the member dashboard's "Top 10 Entry" field was the only competition
// entry point, and it always called POST /top10/enter regardless of which
// competition the member actually meant. The Arena (R250, votes-until-close,
// free-credit eligible) was silently entered and charged as if it were the
// Top 10 (R100, monthly). The fix: GET /competitions now returns entry_fee,
// the member dashboard offers a real competition picker that reads it, and
// createSubmission('top10') branches on the chosen competition's kind
// instead of assuming Top 10. This test covers the backend piece (real HTTP
// + real Postgres) and the two frontend files as static source checks.
//
// Website remediation punch-list (2026-09-03).
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
let memberToken;
let profileId;
let arenaId;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-arenaentrytest-'));
const port = 60000 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

function migrationFiles() {
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
    .map((f) => path.join(dir, f));
}

async function req(method, urlPath, { token, body } = {}) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, body: json };
}

before(async () => {
  pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: false,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('unplug_test');

  process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${port}/unplug_test`;
  process.env.JWT_SECRET = 'test-secret-for-arena-entry';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const file of migrationFiles()) {
    await pool.query(fs.readFileSync(file, 'utf8'));
  }

  const jwt = require('jsonwebtoken');
  const userResult = await pool.query(
    `INSERT INTO users (email, password_hash, role) VALUES ('arenamember@test.com', 'x', 'member') RETURNING id`
  );
  const userId = userResult.rows[0].id;
  memberToken = jwt.sign({ id: userId, email: 'arenamember@test.com', role: 'member' }, process.env.JWT_SECRET);
  const profileResult = await pool.query(
    `INSERT INTO profiles (user_id, type, package_tier, slug, display_name, status)
     VALUES ($1, 'individual', 'basic', 'arena-member', 'Arena Member', 'approved') RETURNING id`,
    [userId]
  );
  profileId = profileResult.rows[0].id;

  const arenaResult = await pool.query(
    `UPDATE competitions SET status = 'open', closes_at = now() + interval '30 days'
     WHERE slug = 'the-arena' RETURNING id, entry_fee`
  );
  assert.equal(arenaResult.rows.length, 1, 'the-arena competition row should already exist from migrations');
  arenaId = arenaResult.rows[0].id;

  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/', require('../src/routes/competitions'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));

  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}, { timeout: 120000 });

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ backend

test('GET /competitions RETURNS entry_fee — the field the dashboard picker depends on to show the right price', async () => {
  const { status, body } = await req('GET', '/competitions');
  assert.equal(status, 200);
  const arena = body.competitions.find((c) => c.slug === 'the-arena');
  assert.ok(arena, 'the-arena should be in the open list');
  assert.ok('entry_fee' in arena, 'entry_fee must be present so the dashboard is never guessing a price');
  assert.ok(Number(arena.entry_fee) > 0);
});

test('ENTERING THE ARENA CREATES A competition_entries ROW, NOT A TOP 10 ENTRY', async () => {
  const { status, body } = await req('POST', `/competitions/${arenaId}/entries`, { token: memberToken });
  assert.equal(status, 201);
  assert.equal(body.entry.competition_id, arenaId);
  const top10Rows = await pool.query('SELECT count(*) FROM top10_entries WHERE profile_id = $1', [profileId]);
  assert.equal(Number(top10Rows.rows[0].count), 0, 'entering the Arena must not also create a Top 10 entry');
  const entryRow = await pool.query('SELECT entry_fee FROM competition_entries WHERE id = $1', [body.entry.id]);
  assert.equal(Number(entryRow.rows[0].entry_fee), Number(body.entry.entry_fee), 'the entry must be charged the Arena fee, not the Top 10 fee');
});

test('A FREE ARENA CREDIT SETTLES THE ENTRY WITHOUT PAYMENT — the dashboard must read this from the real status, not assume payment is always needed', async () => {
  await pool.query(`UPDATE profiles SET free_arena_credits = 1 WHERE id = $1`, [profileId]);
  await pool.query(`DELETE FROM competition_entries WHERE profile_id = $1`, [profileId]);
  const { status, body } = await req('POST', `/competitions/${arenaId}/entries`, { token: memberToken });
  assert.equal(status, 201);
  assert.equal(body.entry.status, 'pending', 'a credited entry should not be awaiting_payment');
  const credit = await pool.query('SELECT free_arena_credits FROM profiles WHERE id = $1', [profileId]);
  assert.equal(Number(credit.rows[0].free_arena_credits), 0, 'the credit should be consumed');
});

// ------------------------------------------------------------- frontend: magazine page

function readMagazine() {
  const file = path.join(__dirname, '..', '..', 'unplug-magazine.html');
  assert.ok(fs.existsSync(file), 'unplug-magazine.html should exist');
  return fs.readFileSync(file, 'utf8').split('\r\n').join('\n');
}

test('goToMemberDashboard ACCEPTS AN OPTIONAL SLUG AND APPENDS IT AS ?competition= — every other call site is unaffected by omitting it', () => {
  const src = readMagazine();
  const start = src.indexOf('function goToMemberDashboard(');
  assert.ok(start > -1);
  const body = src.slice(start, start + 400);
  assert.match(body, /competitionSlug/, 'the function should take the slug as a parameter');
  assert.match(body, /\?competition=/, 'it should build the same query param the dashboard reads');
});

test('THE ARENA\'S "SUBMIT A NOMINATION" BUTTON PASSES ARENA_SLUG — this is the mischarge fix itself', () => {
  const src = readMagazine();
  const idx = src.indexOf('Submit a Nomination');
  assert.ok(idx > -1);
  const tag = src.slice(Math.max(0, idx - 250), idx);
  assert.match(tag, /goToMemberDashboard\(ARENA_SLUG\)/,
    'the Arena page must deep-link with its own slug, not a bare goToMemberDashboard() that lands on the Top 10 default');
});

// ------------------------------------------------------------- frontend: member dashboard

function readDashboard() {
  const file = path.join(__dirname, '..', '..', 'unplug-member-dashboard.html');
  assert.ok(fs.existsSync(file), 'unplug-member-dashboard.html should exist');
  return fs.readFileSync(file, 'utf8').split('\r\n').join('\n');
}

test('THE COMPETITION PICKER READS THE REAL /competitions LIST, KEYED BY id, NOT A HARDCODED ARENA-ONLY OPTION', () => {
  const src = readDashboard();
  const start = src.indexOf('async function setupCompetitionFields()');
  assert.ok(start > -1);
  const body = src.slice(start, start + 2400);
  assert.match(body, /api\('\/competitions'\)/);
  assert.match(body, /kind:\s*'competition'/, 'a real competition must be tagged distinctly from Top 10');
  assert.match(body, /new URLSearchParams\(location\.search\)\.get\('competition'\)/,
    'a deep-linked slug must pre-select the matching option');
});

test('ARRIVING WITH ?competition= ALSO SWITCHES "WHAT ARE YOU SUBMITTING?" TO THE COMPETITIONS FIELDS — pre-selecting the inner dropdown is not enough if the section showing it is never revealed', () => {
  const src = readDashboard();
  const idx = src.indexOf("dispatchEvent(new Event('change'))");
  assert.ok(idx > -1, 'the outer select must be switched with a dispatched change event, not just .value');
  const block = src.slice(Math.max(0, idx - 500), idx + 100);
  assert.match(block, /submitType/, 'it must target the outer "What are you submitting?" select');
  assert.match(block, /get\('competition'\)/, 'the switch must be conditional on the same ?competition= param the picker reads');
});

test('createSubmission(\'top10\') BRANCHES ON THE CHOSEN COMPETITION INSTEAD OF ALWAYS CALLING /top10/enter', () => {
  const src = readDashboard();
  const start = src.indexOf("if (type === 'top10') {");
  assert.ok(start > -1);
  const body = src.slice(start, start + 1300);
  assert.match(body, /COMP_OPTIONS\[document\.getElementById\('comp-select'\)\.value\]/,
    'the chosen competition must come from the trusted COMP_OPTIONS map, not a raw form value');
  assert.match(body, /\/competitions\/\$\{chosen\.id\}\/entries/, 'a real competition must POST to the real entries route');
  assert.match(body, /data\.entry\.status === 'awaiting_payment'/,
    'needsPayment must come from the real returned status so a free Arena credit is not double-charged');
});
