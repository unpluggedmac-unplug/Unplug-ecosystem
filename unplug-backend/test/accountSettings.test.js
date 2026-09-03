// Account Settings (spec §4) — notification preferences.
//
// The notification_preferences table has existed since the notifications work
// and memberNotify.js has been READING it to decide whether to email somebody.
// Nothing ever wrote to it and no screen ever showed it, so a member could be
// emailed with no way to stop it. This is the missing half.
//
// What these protect:
//
//   1. THE SCREEN AND THE SENDER AGREE. If this says "email: on" while the
//      sender assumes off, a member is told one thing and sent another. The
//      defaults are compared directly against memberNotify's.
//   2. OFF MEANS OFF. A preference that saves but does not take effect is worse
//      than no preference at all, so the switch is followed through to the
//      function that actually decides whether to send.
//   3. IT IS PER MEMBER. One member's choices must not change another's.
//   4. A PARTIAL SAVE DOES NOT WIPE THE REST. Sending one switch must leave the
//      other three alone.

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
let prefs;
let memberNotify;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-acct-'));
const port = 53600 + (process.pid % 300);
const ME = 960501;
const OTHER = 960502;

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
  process.env.JWT_SECRET = 'test-secret-account-settings';
  process.env.UNPLUG_DISABLE_RATE_LIMITS = '1';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(dir, f), 'utf8'));
  }

  prefs = require('../src/utils/notificationPreferences');
  memberNotify = require('../src/utils/memberNotify');

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
     VALUES ($1,'me@acct.test','Me','x','member'), ($2,'other@acct.test','Other','x','member')`,
    [ME, OTHER]);
  tokenMine = jwt.sign({ id: ME, email: 'me@acct.test', role: 'member' }, process.env.JWT_SECRET);
  tokenOther = jwt.sign({ id: OTHER, email: 'other@acct.test', role: 'member' },
    process.env.JWT_SECRET);
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
});

// ------------------------------------------------ the screen and the sender

test('THE SCREEN AND THE SENDER AGREE ON THE DEFAULTS', async () => {
  // memberNotify has its own defaults, because an unreadable preferences row
  // must not silence a notification. If the two disagree, a member is told one
  // thing on this screen and sent another.
  const shown = await prefs.getFor(ME);
  const used = await memberNotify.preferencesFor(ME);

  assert.equal(shown.web, used.web, 'web');
  assert.equal(shown.email, used.email, 'email');
  assert.equal(shown.statusChange, used.statusChange, 'statusChange');
});

test('a member who has never touched this gets everything on', async () => {
  // Someone who has not opened the screen should still be told their submission
  // needs work.
  const res = await api('GET', '/my/notification-preferences', null, tokenMine);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.preferences, {
    web: true, email: true, statusChange: true, achievement: true,
  });
  const rows = await pool.query(
    'SELECT * FROM notification_preferences WHERE user_id = $1', [ME]);
  assert.equal(rows.rowCount, 0, 'and no row is written just for looking');
});

test('OFF MEANS OFF — the sender honours what was saved', async () => {
  // A preference that saves but does not take effect is worse than none. This
  // follows the switch through to the function that actually decides.
  await api('PATCH', '/my/notification-preferences', { email: false }, tokenMine);
  const used = await memberNotify.preferencesFor(ME);
  assert.equal(used.email, false, 'the sender must see the member\'s choice');
  assert.equal(used.web, true, 'and the others are untouched');

  await api('PATCH', '/my/notification-preferences', { email: true }, tokenMine);
});

// ---------------------------------------------------------------- saving

test('A PARTIAL SAVE DOES NOT WIPE THE REST', async () => {
  await api('PATCH', '/my/notification-preferences',
    { web: false, email: false, statusChange: false, achievement: false }, tokenMine);

  // Turn ONE back on.
  const res = await api('PATCH', '/my/notification-preferences', { web: true }, tokenMine);
  assert.deepEqual(res.body.preferences, {
    web: true, email: false, statusChange: false, achievement: false,
  }, 'sending one switch must leave the other three as they were');
});

test('what was saved is what comes back', async () => {
  const res = await api('GET', '/my/notification-preferences', null, tokenMine);
  assert.deepEqual(res.body.preferences, {
    web: true, email: false, statusChange: false, achievement: false,
  });
});

test('saving twice is not a second row', async () => {
  await api('PATCH', '/my/notification-preferences', { achievement: true }, tokenMine);
  await api('PATCH', '/my/notification-preferences', { achievement: false }, tokenMine);
  const rows = await pool.query(
    'SELECT count(*)::int AS n FROM notification_preferences WHERE user_id = $1', [ME]);
  assert.equal(rows.rows[0].n, 1, 'the upsert must update, not insert again');
});

test('nonsense is ignored rather than failing the whole save', async () => {
  // A screen sending a stale field should not cost a member their other changes.
  const before = await api('GET', '/my/notification-preferences', null, tokenMine);
  const res = await api('PATCH', '/my/notification-preferences',
    { not_a_setting: true, email: 'yes please', web: true }, tokenMine);
  assert.equal(res.status, 200);
  assert.equal(res.body.preferences.web, true, 'the valid boolean was applied');
  assert.equal(res.body.preferences.email, before.body.preferences.email,
    'a non-boolean was ignored, not coerced');
  assert.ok(!('not_a_setting' in res.body.preferences));
});

test('an empty save changes nothing', async () => {
  const before = await api('GET', '/my/notification-preferences', null, tokenMine);
  const res = await api('PATCH', '/my/notification-preferences', {}, tokenMine);
  assert.deepEqual(res.body.preferences, before.body.preferences);
});

// -------------------------------------------------------------- ownership

test('IT IS PER MEMBER', async () => {
  const mine = await api('GET', '/my/notification-preferences', null, tokenMine);
  const theirs = await api('GET', '/my/notification-preferences', null, tokenOther);

  // Mine have been changed above; theirs have never been touched.
  assert.deepEqual(theirs.body.preferences, {
    web: true, email: true, statusChange: true, achievement: true,
  });
  assert.notDeepEqual(mine.body.preferences, theirs.body.preferences);
});

test('one member changing theirs does not change another\'s', async () => {
  await api('PATCH', '/my/notification-preferences', { web: false }, tokenOther);
  const stillMine = await memberNotify.preferencesFor(ME);
  assert.equal(stillMine.web, true, 'my web notifications were switched off by someone else');
});

test('signed out cannot read or change anything', async () => {
  assert.equal((await api('GET', '/my/notification-preferences', null, null)).status, 401);
  assert.equal(
    (await api('PATCH', '/my/notification-preferences', { email: false }, null)).status, 401);
});

// ------------------------------------------------------------- the screen

test('the switches describe themselves, so the page keeps no copy', async () => {
  const res = await api('GET', '/my/notification-preferences', null, tokenMine);
  assert.equal(res.body.fields.length, prefs.FIELDS.length);
  for (const f of res.body.fields) {
    assert.ok(f.key && f.label, `${JSON.stringify(f)} needs a key and a label`);
    assert.ok(Object.prototype.hasOwnProperty.call(res.body.preferences, f.key),
      `${f.key} is offered as a switch but has no value`);
  }
});

test('every switch maps to a column that exists', async () => {
  // A switch pointing at a missing column would save nothing, silently.
  const cols = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'notification_preferences'`);
  const have = new Set(cols.rows.map((r) => r.column_name));
  for (const f of prefs.FIELDS) {
    assert.ok(have.has(f.column), `${f.key} maps to ${f.column}, which does not exist`);
  }
});
