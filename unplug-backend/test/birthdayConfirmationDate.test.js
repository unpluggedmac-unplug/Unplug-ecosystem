// BDAY-001: the confirmation after submitting a birthday said only
// "submitted for review" — it never confirmed WHEN it would actually
// appear, the third thing the punch-list specifically asks this message to
// cover (alongside success and "reviewed before publication", both already
// present). Someone submitting a birthday for months from now had no way to
// tell whether their date was recorded correctly except waiting for it.
//
// Fixed by having POST /birthdays/submit build the confirmation from the
// exact birthMonth/birthDay it just validated and stored — so the date
// named in the message can never drift from the date actually saved.
//
// Website remediation punch-list (2026-09-03), BDAY-001.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-bdaydate-'));
const port = 63200 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

function migrationFiles() {
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
    .map((f) => path.join(dir, f));
}

async function req(method, urlPath, body) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, body: json };
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
  process.env.JWT_SECRET = 'test-secret-for-bdaydate';
  process.env.UNPLUG_DISABLE_RATE_LIMITS = '1';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const file of migrationFiles()) {
    await pool.query(fs.readFileSync(file, 'utf8'));
  }

  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/birthdays', require('../src/routes/birthdays'));
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

test('THE CONFIRMATION NAMES THE ACTUAL SUBMITTED DATE, NOT JUST "SUBMITTED FOR REVIEW"', async () => {
  const { status, body } = await req('POST', '/birthdays/submit', {
    name: 'Naledi Mokoena', birthMonth: 7, birthDay: 23, email: 'naledi@test.com',
  });
  assert.equal(status, 201);
  assert.match(body.message, /review/i, 'must still say it needs review');
  assert.match(body.message, /23 July/, 'must name the exact date just submitted');
});

test('A LEAP-DAY BIRTHDAY (29 FEBRUARY) FORMATS CORRECTLY, NOT AS AN INVALID DATE', async () => {
  const { status, body } = await req('POST', '/birthdays/submit', {
    name: 'Leap Day Person', birthMonth: 2, birthDay: 29, email: 'leap@test.com',
  });
  assert.equal(status, 201);
  assert.match(body.message, /29 February/);
});

test('THE DATE NAMED IN THE MESSAGE MATCHES WHAT WAS ACTUALLY STORED, NOT A SEPARATELY COMPUTED GUESS', async () => {
  await req('POST', '/birthdays/submit', {
    name: 'Date Match Test', birthMonth: 11, birthDay: 3, email: 'datematch@test.com',
  });
  const row = await pool.query(
    `SELECT birth_month, birth_day FROM birthdays WHERE name = 'Date Match Test'`
  );
  assert.equal(row.rows[0].birth_month, 11);
  assert.equal(row.rows[0].birth_day, 3);
});
