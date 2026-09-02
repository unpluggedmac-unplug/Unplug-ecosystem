// A DATE must come back as the day it was stored, in every timezone.
//
// node-postgres parsed a DATE into a Date at midnight in the SERVER'S timezone,
// and JSON.stringify then wrote that in UTC. East of Greenwich the two disagree
// about which day it is, so an event on Saturday was published as Friday:
//
//   stored               2026-10-31
//   sent as JSON         "2026-10-30T22:00:00.000Z"   (server in SAST)
//   read by the page     "2026-10-30"                 <-- the day before
//
// Latent rather than live, because Render runs in UTC where the two agree — and
// that is exactly why it needed a test that does NOT depend on the machine's
// timezone to catch it. A test asserting the absolute date passes on a UTC CI
// box no matter how broken the parsing is.
//
// So these assert the SHAPE: a DATE arrives as the exact 'YYYY-MM-DD' text
// Postgres sent, never a Date object. That fails everywhere, UTC included, if
// the type parser in src/pgTypes.js is removed.
//
// One test additionally re-runs the whole thing in a FORCED non-UTC timezone in
// a child process, which is the closest thing to reproducing the original bug.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const EmbeddedPostgres = require('embedded-postgres').default;
const { stopPostgres } = require('./helpers/stopPostgres');
const { ensureStopWords } = require('./helpers/textSearch');

// Loading the app's db module is what registers the parser, exactly as in
// production. Requiring it here rather than calling setTypeParser directly
// means the test breaks if that wiring is removed, not just the parser.
require('../src/pgTypes');

let pg;
let pool;
let server;
let baseUrl;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-dateshift-'));
const port = 49600 + (process.pid % 300);

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
  process.env.JWT_SECRET = 'test-secret-date-shift';
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
  app.use('/events', require('../src/routes/events'));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await pool.query(`INSERT INTO users (id, email, full_name, password_hash, role)
                    VALUES (970001, 'shift@ev.test', 'Shift', 'x', 'member')`);
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
});

test('A DATE COMES BACK AS TEXT, NOT AS A MOMENT IN TIME', async () => {
  // The whole bug in one assertion. A Date object here means the conversion is
  // back, and with it the timezone that has no business being involved.
  const r = await pool.query(`SELECT '2026-10-31'::date AS d`);
  assert.equal(typeof r.rows[0].d, 'string',
    'a DATE must not be converted into a Date object');
  assert.equal(r.rows[0].d, '2026-10-31');
  assert.ok(!(r.rows[0].d instanceof Date));
});

test('the day survives being sent as JSON', async () => {
  // JSON.stringify is where the conversion actually did its damage.
  const r = await pool.query(`SELECT '2026-10-31'::date AS d`);
  assert.equal(JSON.parse(JSON.stringify(r.rows[0])).d, '2026-10-31',
    'the day on the wire must be the day in the table');
});

test('AN EVENT ON SATURDAY IS PUBLISHED AS SATURDAY', async () => {
  // End to end, through the real route: the case that was actually wrong.
  await pool.query(
    `INSERT INTO events (organizer_user_id, name, event_date, end_date, status)
     VALUES (970001, 'Saturday concert', '2026-10-31', '2026-11-02', 'approved')`);

  const res = await fetch(`${baseUrl}/events/upcoming?limit=100`);
  const body = await res.json();
  const mine = body.events.find((e) => e.name === 'Saturday concert');

  assert.ok(mine, 'the event should be listed');
  assert.equal(mine.event_date, '2026-10-31', 'the day it starts');
  assert.equal(mine.end_date, '2026-11-02', 'and the day it ends');
});

test('a NULL date is still null, not an empty string', async () => {
  const r = await pool.query(`SELECT NULL::date AS d`);
  assert.equal(r.rows[0].d, null, 'NULL still means "not set"');
});

test('date arithmetic in Postgres is unaffected', async () => {
  // The parser changes only how the answer is carried back, never how it is
  // worked out — comparisons and maths stay in SQL, where they belong.
  const r = await pool.query(
    `SELECT ('2026-10-31'::date + 2) AS plus2,
            ('2026-11-02'::date > '2026-10-31'::date) AS later`);
  assert.equal(r.rows[0].plus2, '2026-11-02');
  assert.equal(r.rows[0].later, true);
});

test('TIMESTAMPTZ is left alone — it really is a moment in time', async () => {
  // The fix is deliberately narrow. A timestamptz round-trips correctly already
  // and must keep behaving as a Date.
  const r = await pool.query(`SELECT now() AS t, created_at FROM users WHERE id = 970001`);
  assert.ok(r.rows[0].t instanceof Date, 'now() must still be a Date');
  assert.ok(r.rows[0].created_at instanceof Date, 'and so must a TIMESTAMPTZ column');
});

test('THE DAY HOLDS EVEN WHEN THE SERVER IS NOT IN UTC', async () => {
  // The original bug only appeared outside UTC, so this forces a timezone that
  // would have shown it: UTC+14, the largest offset there is. Run in a child
  // process because TZ is read once, when the process starts.
  const script = `
    require(${JSON.stringify(path.join(__dirname, '..', 'src', 'pgTypes.js'))});
    const { Pool } = require(${JSON.stringify(path.join(__dirname, '..', 'node_modules', 'pg'))});
    const pool = new Pool({ connectionString: ${JSON.stringify(process.env.DATABASE_URL)} });
    (async () => {
      const r = await pool.query("SELECT event_date, end_date FROM events WHERE name = 'Saturday concert'");
      process.stdout.write(JSON.stringify(r.rows[0]));
      await pool.end();
    })().catch((e) => { process.stderr.write(String(e)); process.exit(1); });
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, TZ: 'Pacific/Kiritimati' }, // UTC+14
    encoding: 'utf8',
  });
  const row = JSON.parse(out);
  assert.equal(row.event_date, '2026-10-31',
    'the stored day must not move because the server sits in a different timezone');
  assert.equal(row.end_date, '2026-11-02');
});
