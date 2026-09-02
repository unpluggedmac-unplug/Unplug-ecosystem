// A multi-day event used to vanish part-way through itself.
//
// events carried event_date, start_time and end_time but no END DATE, and the
// public feed asked:
//
//   status = 'approved' AND event_date >= CURRENT_DATE
//
// So a festival running Friday to Sunday, with one event_date of Friday, was
// removed from the site on Saturday morning — while it was still running and
// still selling tickets. start_time and end_time did not help: they are times
// of day, not dates.
//
// What these protect:
//
//   1. A MULTI-DAY EVENT STAYS UP UNTIL ITS LAST DAY, and goes after it.
//   2. NOTHING CHANGES FOR A SINGLE-DAY EVENT. end_date is NULL on every row
//      that existed before this, so the old behaviour has to be exactly
//      preserved for them — that is what makes the change safe to deploy.
//   3. AN EVENT CANNOT END BEFORE IT STARTS, refused with a sentence rather
//      than a constraint violation.

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
let memberToken;
let adminToken;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-evend-'));
const port = 48800 + (process.pid % 300); // bases are 400 apart so ranges cannot overlap

async function api(method, urlPath, body, token) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
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
  process.env.JWT_SECRET = 'test-secret-for-event-end';
  process.env.UNPLUG_DISABLE_RATE_LIMITS = '1';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(dir, f), 'utf8'));
  }

  const jwt = require('jsonwebtoken');
  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/events', require('../src/routes/events'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await pool.query(`INSERT INTO users (id, email, full_name, password_hash, role)
                    VALUES (880001, 'organiser@ev.test', 'Organiser', 'x', 'member'),
                           (880002, 'admin@ev.test', 'Admin', 'x', 'admin')`);
  memberToken = jwt.sign({ id: 880001, email: 'organiser@ev.test', role: 'member' }, process.env.JWT_SECRET);
  adminToken = jwt.sign({ id: 880002, email: 'admin@ev.test', role: 'admin' }, process.env.JWT_SECRET);
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
});

// Dates relative to today, so the test is not tied to a calendar.
const day = (n) => `now() + interval '${n} day'`;

async function approvedEvent(name, startOffset, endOffset) {
  const r = await pool.query(
    `INSERT INTO events (organizer_user_id, name, event_date, end_date, status)
     VALUES (880001, $1, (${day(startOffset)})::date,
             ${endOffset === null ? 'NULL' : `(${day(endOffset)})::date`}, 'approved')
     RETURNING id`,
    [name]
  );
  return r.rows[0].id;
}

const upcomingIds = async () => {
  const res = await api('GET', '/events/upcoming?limit=100');
  return (res.body.events || []).map((e) => e.id);
};

// ---------------------------------------------------------------------------

test('A FESTIVAL THAT STARTED YESTERDAY AND ENDS TOMORROW IS STILL SHOWN', async () => {
  // The bug, stated directly. Under the old condition this event was gone the
  // morning after it opened.
  const id = await approvedEvent('Three-day festival', -1, 1);
  assert.ok((await upcomingIds()).includes(id),
    'an event that is still running must still be on the site');
});

test('...and is gone once its last day has passed', async () => {
  const id = await approvedEvent('Festival that ended', -5, -2);
  assert.equal((await upcomingIds()).includes(id), false);
});

test('an event running until TODAY is still shown', async () => {
  // The boundary. Somebody looking for it on the closing day should find it.
  const id = await approvedEvent('Ends today', -3, 0);
  assert.ok((await upcomingIds()).includes(id));
});

// ------------------------------------------- nothing changes for one day

test('NOTHING CHANGES FOR A SINGLE-DAY EVENT', async () => {
  // Every event that existed before this change has end_date NULL, so the old
  // behaviour must be exactly preserved for them. This is what makes the change
  // safe to deploy against live data.
  const today = await approvedEvent('Happening today', 0, null);
  const future = await approvedEvent('Next week', 7, null);
  const past = await approvedEvent('Last week', -7, null);

  const ids = await upcomingIds();
  assert.ok(ids.includes(today), 'a single-day event today still shows');
  assert.ok(ids.includes(future), 'and a future one');
  assert.equal(ids.includes(past), false, 'and a past one still does not');
});

test('events are still ordered by when they start', async () => {
  const res = await api('GET', '/events/upcoming?limit=100');
  const dates = (res.body.events || []).map((e) => String(e.event_date));
  const sorted = [...dates].sort();
  assert.deepEqual(dates, sorted, 'the calendar still reads in order');
});

test('the feed returns the end date so the front end can show a range', async () => {
  const id = await approvedEvent('Has an end', 1, 3);
  const res = await api('GET', '/events/upcoming?limit=100');
  const mine = (res.body.events || []).find((e) => e.id === id);
  assert.ok(mine, 'the event should be listed');
  assert.ok(mine.end_date, 'and carry its end date');
});

test('both dates reach the page as the days they were stored as', async () => {
  // This used to be able to assert only that end_date travelled the SAME way
  // event_date did, because both were shifted a day by the timezone conversion
  // in node-postgres — asserting the real date would have failed on any machine
  // east of Greenwich while passing on a UTC server. src/pgTypes.js removed the
  // conversion, so the actual day can now be asserted, which is what matters.
  // The shift itself is covered in depth by test/dateNoTimezoneShift.test.js.
  const stored = await pool.query(
    `SELECT to_char(event_date, 'YYYY-MM-DD') AS s,
            to_char(end_date, 'YYYY-MM-DD') AS e
       FROM events WHERE name = 'Has an end'`);

  const res = await api('GET', '/events/upcoming?limit=100');
  const mine = (res.body.events || []).find((e) => e.name === 'Has an end');

  assert.equal(mine.event_date, stored.rows[0].s, 'the day it starts');
  assert.equal(mine.end_date, stored.rows[0].e, 'the day it ends');

  const span = Math.round(
    (Date.parse(mine.end_date) - Date.parse(mine.event_date)) / 86400000);
  assert.equal(span, 2, 'a three-day event is still three days long on the wire');
});

// ------------------------------------------------------------ validation

test('AN EVENT CANNOT END BEFORE IT STARTS', async () => {
  const res = await api('POST', '/events', {
    name: 'Backwards festival', eventDate: '2026-10-10', endDate: '2026-10-08',
  }, memberToken);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /end date cannot be before/i);
});

test('the database refuses it too, not only the route', async () => {
  // The route's check is for the organiser's benefit; the constraint is what
  // actually guarantees it, including for anything writing directly.
  await assert.rejects(
    () => pool.query(
      `INSERT INTO events (organizer_user_id, name, event_date, end_date, status)
       VALUES (880001, 'Direct write', '2026-10-10', '2026-10-08', 'approved')`),
    /violates check constraint/
  );
});

test('an event submitted with an end date keeps it', async () => {
  const res = await api('POST', '/events', {
    name: 'Weekend market', eventDate: '2026-11-06', endDate: '2026-11-08',
  }, memberToken);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  // Asked for as text: pg hands back a Date object for a DATE column, and
  // formatting that in the local zone is exactly how an off-by-one day gets in.
  const row = await pool.query(
    `SELECT to_char(end_date, 'YYYY-MM-DD') AS end_date FROM events WHERE name = 'Weekend market'`);
  assert.equal(row.rows[0].end_date, '2026-11-08');
});

// ----------------------------------------------- the admin editing an event

test('an admin can turn a one-day event into a multi-day one', async () => {
  const id = await approvedEvent('Grew into a festival', 5, null);
  const res = await api('PATCH', `/events/${id}`, { endDate: '2027-01-20' }, adminToken);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const row = await pool.query(
    `SELECT to_char(end_date, 'YYYY-MM-DD') AS e FROM events WHERE id = $1`, [id]);
  assert.equal(row.rows[0].e, '2027-01-20');
});

test('UNDO CAN TAKE THE END DATE BACK OFF AGAIN', async () => {
  // The admin form's Undo replays the values it snapshotted before the edit. If
  // a field is sent as undefined it is dropped by JSON.stringify and the PATCH
  // skips it, so Undo would appear to work and silently leave the end date on.
  // Sending null is what makes undo honest.
  const id = await approvedEvent('Back to one day', 5, 7);
  const res = await api('PATCH', `/events/${id}`, { endDate: null }, adminToken);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const row = await pool.query(`SELECT end_date FROM events WHERE id = $1`, [id]);
  assert.equal(row.rows[0].end_date, null, 'undo must actually clear it');
});

test('an admin editing gets a sentence, not a 500, for a backwards date', async () => {
  // The PATCH may set the end date WITHOUT the start date, so whether the two
  // agree depends on the row already stored. This has to come back as advice.
  const id = await approvedEvent('Existing event', 10, null);
  const res = await api('PATCH', `/events/${id}`, { endDate: '2020-01-01' }, adminToken);
  assert.equal(res.status, 400, 'a constraint violation must not surface as a server error');
  assert.match(res.body.error, /end date cannot be before/i);
});

test('an event submitted without one is still a single-day event', async () => {
  const res = await api('POST', '/events', {
    name: 'One-day talk', eventDate: '2026-11-20',
  }, memberToken);
  assert.equal(res.status, 201);
  const row = await pool.query(`SELECT end_date FROM events WHERE name = 'One-day talk'`);
  assert.equal(row.rows[0].end_date, null, 'NULL means one day; nothing is invented');
});
