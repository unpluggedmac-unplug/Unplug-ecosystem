// Admin notifications for everything, against a REAL PostgreSQL.
//
// The table had one writer. Now most of the site writes to it, and the rules
// that keep it usable are the ones worth pinning down:
//
//   1. ROLLING UP ONLY INTO UNREAD ROWS. Comments fold into one line with a
//      count. Once an admin has read that line, the next comment starts a
//      fresh row — otherwise a notification they had dealt with would quietly
//      climb and they could never tell what was new;
//   2. THE MESSAGE COUNTS. A rolled-up row must say "7 new comments", not keep
//      the wording of the first one while six more hide behind it;
//   3. A SYSTEM ERROR CANNOT FLOOD THE LIST. A broken endpoint throws
//      thousands of times a minute; unrolled, the outage would erase the very
//      screen you would use to notice it;
//   4. RECORDING A NOTIFICATION NEVER BREAKS THE THING THAT CAUSED IT. A
//      failed insert must not fail a signup, a comment or a payment.
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
let notify;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-notify-'));
const port = 35200 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

async function rows() {
  const r = await pool.query(
    `SELECT id, type, message, detail, link_section, dedupe_key, event_count, read
       FROM admin_notifications ORDER BY id`);
  return r.rows;
}
async function clear() { await pool.query('DELETE FROM admin_notifications'); }

before(async () => {
  pg = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'postgres', password: 'postgres', port,
    persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('unplug_test');
  process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${port}/unplug_test`;
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }
  notify = require('../src/utils/adminNotify');
});

after(async () => {
  if (pool) await pool.end();
  // stopPostgres, not pg.stop() directly: on Windows the library's stop
  // can HANG rather than throw, which used to leave the cluster running
  // with no parent and eventually broke a later test file's startup.
  // See test/helpers/stopPostgres.js.
  await stopPostgres(pg, dataDir);
});

// ---------------------------------------------------------------------------
// Rolling up
// ---------------------------------------------------------------------------

test('SEVEN COMMENTS MAKE ONE ROW, NOT SEVEN', async () => {
  await clear();
  for (let i = 0; i < 7; i += 1) {
    await notify.notifyAdmin({
      type: notify.NOTIFY.COMMENT_POSTED,
      message: 'New comment awaiting approval',
      plural: '%n new comments awaiting approval',
      dedupeKey: 'comments:pending',
      link: 'comments',
    });
  }
  const list = await rows();
  assert.equal(list.length, 1, 'one line, however many comments');
  assert.equal(list[0].event_count, 7);
});

test('THE ROLLED-UP MESSAGE SAYS HOW MANY', async () => {
  // Without this the row keeps the first event's wording and six more hide
  // behind a line that reads as one.
  const list = await rows();
  assert.equal(list[0].message, '7 new comments awaiting approval');
});

test('the first one reads as one, not as "1 new comments"', async () => {
  await clear();
  await notify.notifyAdmin({
    type: notify.NOTIFY.COMMENT_POSTED,
    message: 'New comment awaiting approval',
    plural: '%n new comments awaiting approval',
    dedupeKey: 'comments:pending',
  });
  const list = await rows();
  assert.equal(list[0].message, 'New comment awaiting approval');
  assert.equal(list[0].event_count, 1);
});

test('ONCE READ, THE NEXT EVENT STARTS A FRESH ROW', async () => {
  // The rule that makes the count trustworthy. Rolling into a row the admin
  // has already dealt with would make it climb again with no way to tell what
  // was new.
  await clear();
  await notify.notifyAdmin({
    type: notify.NOTIFY.COMMENT_POSTED, message: 'New comment awaiting approval',
    plural: '%n new comments awaiting approval', dedupeKey: 'comments:pending',
  });
  await pool.query('UPDATE admin_notifications SET read = true');

  await notify.notifyAdmin({
    type: notify.NOTIFY.COMMENT_POSTED, message: 'New comment awaiting approval',
    plural: '%n new comments awaiting approval', dedupeKey: 'comments:pending',
  });

  const list = await rows();
  assert.equal(list.length, 2, 'a new row rather than reopening the old one');
  assert.equal(list[1].event_count, 1, 'and it starts counting again from one');
});

test('different things roll into different rows', async () => {
  await clear();
  await notify.notifyAdmin({ type: 'a', message: 'Comments', dedupeKey: 'comments:pending' });
  await notify.notifyAdmin({ type: 'b', message: 'Reviews', dedupeKey: 'reviews:pending' });
  await notify.notifyAdmin({ type: 'a', message: 'Comments', dedupeKey: 'comments:pending' });
  const list = await rows();
  assert.equal(list.length, 2);
  assert.equal(list.find((r) => r.dedupe_key === 'comments:pending').event_count, 2);
  assert.equal(list.find((r) => r.dedupe_key === 'reviews:pending').event_count, 1);
});

test('WITHOUT A KEY, EVERY EVENT KEEPS ITS OWN ROW', async () => {
  // Two payments of R95 are two different people who each paid. A line saying
  // "2 payments" would hide which.
  await clear();
  for (let i = 0; i < 3; i += 1) {
    await notify.notifyAdmin({
      type: notify.NOTIFY.PAYMENT_CONFIRMED,
      message: 'Payment confirmed — R95.00',
      link: 'payments',
    });
  }
  const list = await rows();
  assert.equal(list.length, 3, 'each payment is its own line');
});

// ---------------------------------------------------------------------------
// A broken endpoint must not erase the list
// ---------------------------------------------------------------------------

test('A THOUSAND IDENTICAL ERRORS MAKE ONE ROW', async () => {
  // The outage must not wipe out the screen you would use to notice it.
  await clear();
  for (let i = 0; i < 1000; i += 1) {
    await notify.notifyAdmin({
      type: notify.NOTIFY.SYSTEM_ERROR,
      message: 'Something failed on GET /articles/:id',
      plural: 'Something failed on GET /articles/:id (%n times)',
      detail: 'column x does not exist',
      dedupeKey: 'err:GET /articles/:id:column x does not exist',
    });
  }
  const list = await rows();
  assert.equal(list.length, 1);
  assert.equal(list[0].event_count, 1000);
  assert.match(list[0].message, /1000 times/, 'and it says how bad it is');
});

test('a genuinely different fault still gets its own row', async () => {
  await clear();
  await notify.notifyAdmin({
    type: notify.NOTIFY.SYSTEM_ERROR, message: 'Failed on /a',
    dedupeKey: 'err:GET /a:one thing',
  });
  await notify.notifyAdmin({
    type: notify.NOTIFY.SYSTEM_ERROR, message: 'Failed on /b',
    dedupeKey: 'err:GET /b:another thing',
  });
  assert.equal((await rows()).length, 2, 'two problems, two rows');
});

// ---------------------------------------------------------------------------
// It must never break what caused it
// ---------------------------------------------------------------------------

test('RECORDING A NOTIFICATION NEVER THROWS AT THE CALLER', async () => {
  // notifyAdminAsync is called from signup, comment and payment paths. If it
  // could throw, a database hiccup would fail a member's signup over a line
  // in an admin list.
  assert.doesNotThrow(() => {
    notify.notifyAdminAsync({ type: 'x', message: 'fine' });
    notify.notifyAdminAsync({});                       // incomplete
    notify.notifyAdminAsync(null);                     // nothing at all
    notify.notifyAdminAsync({ type: 'x' });            // no message
  });
  // Give the fire-and-forget calls a moment to settle without being awaited.
  await new Promise((r) => setTimeout(r, 150));
});

test('an incomplete notification is ignored rather than stored empty', async () => {
  await clear();
  const a = await notify.notifyAdmin({ message: 'no type' });
  const b = await notify.notifyAdmin({ type: 'no message' });
  assert.equal(a.recorded, false);
  assert.equal(b.recorded, false);
  assert.equal((await rows()).length, 0);
});

test('over-long text is cut rather than rejected', async () => {
  // A stack trace in detail, or a very long name in message, must not lose
  // the notification to a column-length error.
  await clear();
  await notify.notifyAdmin({
    type: 'x',
    message: 'm'.repeat(900),
    detail: 'd'.repeat(5000),
  });
  const list = await rows();
  assert.equal(list.length, 1);
  assert.ok(list[0].message.length <= 500);
  assert.ok(list[0].detail.length <= 2000);
});

// ---------------------------------------------------------------------------
// What the screen needs
// ---------------------------------------------------------------------------

test('a notification carries where to go and what it was about', async () => {
  await clear();
  await notify.notifyAdmin({
    type: notify.NOTIFY.ENQUIRY,
    message: 'New advertising enquiry from Kagiso Motors',
    detail: 'Subject: rates for a 28-day banner',
    link: 'inquiries',
  });
  const n = (await rows())[0];
  assert.equal(n.link_section, 'inquiries', 'a notification you cannot act on from is half a notification');
  assert.match(n.detail, /28-day banner/);
});

test('the feed orders unread first, then most recent activity', async () => {
  await clear();
  await notify.notifyAdmin({ type: 'x', message: 'Old and read' });
  await pool.query('UPDATE admin_notifications SET read = true');
  await notify.notifyAdmin({ type: 'x', message: 'New and unread' });

  const r = await pool.query(
    `SELECT message, read FROM admin_notifications
      ORDER BY read ASC, COALESCE(last_seen_at, created_at) DESC`);
  assert.equal(r.rows[0].message, 'New and unread', 'unread comes first');
});

test('last_seen_at moves with the newest event, created_at does not', async () => {
  // A rolled-up row that sorted by created_at would sink to the bottom while
  // it was still actively filling up.
  await clear();
  await notify.notifyAdmin({
    type: 'x', message: 'Rolling', plural: '%n rolling', dedupeKey: 'roll:me',
  });
  const first = await pool.query('SELECT created_at, last_seen_at FROM admin_notifications');
  await new Promise((r) => setTimeout(r, 60));
  await notify.notifyAdmin({
    type: 'x', message: 'Rolling', plural: '%n rolling', dedupeKey: 'roll:me',
  });
  const second = await pool.query('SELECT created_at, last_seen_at FROM admin_notifications');

  assert.deepEqual(second.rows[0].created_at, first.rows[0].created_at, 'created_at stays put');
  assert.ok(second.rows[0].last_seen_at > first.rows[0].last_seen_at, 'last_seen_at moves');
});

test('re-running the migrations keeps existing notifications', async () => {
  await clear();
  await notify.notifyAdmin({ type: 'x', message: 'Survives a deploy' });
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }
  const list = await rows();
  assert.equal(list.length, 1);
  assert.equal(list[0].message, 'Survives a deploy');
});
