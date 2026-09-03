// The record of what happened, and the monthly account of it.
//
// What these protect:
//
//   1. A SUBMISSION IS RECORDED WHEN IT IS MADE, not only when an admin acts on
//      it. Otherwise the monthly record shows decisions with no sight of what
//      came in.
//   2. WHO DID IT is kept. Staff decisions and members' own submissions are both
//      in one table, and a record that cannot tell them apart is not a record.
//   3. THE MONTH IS A SOUTH AFRICAN MONTH. Render runs in UTC and SAST is UTC+2,
//      so a boundary taken in UTC files everything between midnight and 02:00 on
//      the 1st into the wrong month.
//   4. NOTHING IS SILENTLY DROPPED. An action nobody grouped still appears.
//   5. THE REPORT IS SENT ONCE. Render restarts on every deploy and whenever the
//      free instance sleeps; anything relying on memory would resend all month.

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
let report;
let scheduler;
let activityLog;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-activity-'));
const port = 56200 + (process.pid % 300);
const ADMIN = 920001;
const MEMBER = 920002;

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
  process.env.JWT_SECRET = 'test-secret-activity';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(dir, f), 'utf8'));
  }

  report = require('../src/utils/activityReport');
  scheduler = require('../src/utils/activityReportScheduler');
  activityLog = require('../src/routes/activityLog');

  await pool.query(
    `INSERT INTO users (id, email, full_name, password_hash, role)
     VALUES ($1,'admin@act.test','An Admin','x','admin'),
            ($2,'member@act.test','A Member','x','member')`, [ADMIN, MEMBER]);
});

after(async () => {
  scheduler.stop();
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
});

// --------------------------------------------------------------- the record

test('EXISTING ROWS WERE BACKFILLED, NOT LEFT UNKNOWN', async () => {
  // Every action recorded before migration 167 came from an admin-only route,
  // so 'admin' is accurate rather than assumed. Leaving them NULL would make
  // the report guess.
  // Written the way OLD code writes it — without naming the column at all.
  // During a Render deploy the previous instance is still serving while the
  // migration runs, so this is not a hypothetical insert.
  await pool.query(
    `INSERT INTO admin_activity_log (admin_user_id, action, details)
     VALUES ($1,'article_approved','seed')`, [ADMIN]);
  const r = await pool.query(
    `SELECT count(*)::int AS n FROM admin_activity_log WHERE actor_role IS NULL`);
  assert.equal(r.rows[0].n, 0, 'no row should be left without an actor role');

  // And it cannot become blank later either.
  await assert.rejects(
    () => pool.query(
      `INSERT INTO admin_activity_log (admin_user_id, action, actor_role)
       VALUES ($1,'article_approved',NULL)`, [ADMIN]),
    'a row with no actor is refused');
});

test('MIGRATION 167 SURVIVES BEING RE-RUN', async () => {
  // Every migration re-runs on every deploy, so a statement that is not
  // re-runnable is not a slow bug: it is an outage on the next push. ADD
  // CONSTRAINT has no IF NOT EXISTS, which is why 167 drops it first.
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'db', 'migrations', '167_activity_actor_role.sql'), 'utf8');
  await assert.doesNotReject(() => pool.query(sql), 'it must run a second time');
  await assert.doesNotReject(() => pool.query(sql), 'and a third');

  const still = await pool.query(
    `SELECT count(*)::int AS n FROM admin_activity_log WHERE actor_role IS NULL`);
  assert.equal(still.rows[0].n, 0);
});

test('WHO DID IT IS KEPT: staff and members are distinguishable', async () => {
  await activityLog.logActivity(ADMIN, 'article_approved', 'by staff');
  await activityLog.logSubmission(MEMBER, 'event_submitted', 'by a member');

  const r = await pool.query(
    `SELECT actor_role, action FROM admin_activity_log
      WHERE details IN ('by staff','by a member') ORDER BY details`);
  const byRole = Object.fromEntries(r.rows.map((x) => [x.action, x.actor_role]));
  assert.equal(byRole.article_approved, 'admin');
  assert.equal(byRole.event_submitted, 'member');
});

test('a failed audit entry never breaks the thing it describes', async () => {
  // logActivity swallows its own errors on purpose: a database hiccup must not
  // be the reason an admin cannot approve an article.
  await assert.doesNotReject(() => activityLog.logActivity(ADMIN, 'x'.repeat(200), 'too long'));
});

// -------------------------------------------------------- every submission

test('EVERY SUBMISSION TYPE IS LOGGED BY ITS ROUTE', () => {
  // Read from the routes rather than exercised through six HTTP calls: what
  // matters is that no submission path was missed.
  const routes = path.join(__dirname, '..', 'src', 'routes');
  const expected = {
    'articles.js': 'article_submitted',
    'events.js': 'event_submitted',
    'gallery.js': 'gallery_submitted',
    'marketplace.js': 'listing_submitted',
    'adBanners.js': 'advert_submitted',
    'competitions.js': 'competition_entry_submitted',
  };
  for (const [file, action] of Object.entries(expected)) {
    const src = fs.readFileSync(path.join(routes, file), 'utf8');
    assert.ok(src.includes('logSubmission('), `${file} should record submissions`);
    assert.ok(src.includes(`'${action}'`), `${file} should log ${action}`);
  }
});

// ------------------------------------------------------------- the month

test('THE MONTH IS A SOUTH AFRICAN MONTH', () => {
  // September 2026 in SA starts at 00:00 SAST on 1 Sept, which is 22:00 UTC on
  // 31 August. A boundary taken in UTC would put the first two hours of the
  // month into August.
  const { startUtc, endUtc } = report.monthBounds(2026, 9);
  assert.equal(startUtc.toISOString(), '2026-08-31T22:00:00.000Z');
  assert.equal(endUtc.toISOString(), '2026-09-30T22:00:00.000Z');
});

test('an entry just after SA midnight lands in the new month', async () => {
  // 00:30 SAST on 1 September = 22:30 UTC on 31 August.
  await pool.query(
    `INSERT INTO admin_activity_log (admin_user_id, action, details, created_at, actor_role)
     VALUES ($1,'profile_approved','just after midnight','2026-08-31T22:30:00Z','admin')`, [ADMIN]);

  const sept = await report.gather(2026, 9);
  const aug = await report.gather(2026, 8);
  assert.ok(sept.entries.some((e) => e.details === 'just after midnight'),
    'it belongs to September in South Africa');
  assert.ok(!aug.entries.some((e) => e.details === 'just after midnight'),
    'and must not also be counted in August');
});

test('NOTHING IS SILENTLY DROPPED', () => {
  // An action matching no group still has to appear, or the record quietly
  // loses rows as new kinds of action are added.
  assert.equal(report.groupFor('something_nobody_grouped'), 'other');
  assert.equal(report.groupFor('article_approved'), 'approvals');
  assert.equal(report.groupFor('event_submitted'), 'submissions');
  assert.equal(report.groupFor('entry_votes_adjusted'), 'votes');
  assert.equal(report.groupFor('credit_adjusted'), 'money');
});

test('the report counts staff and member activity separately', async () => {
  const now = new Date();
  const { year, month } = { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
  await activityLog.logActivity(ADMIN, 'profile_approved', 'this month, staff');
  await activityLog.logSubmission(MEMBER, 'gallery_submitted', 'this month, member');

  const r = await report.gather(year, month);
  assert.ok(r.byAdmin >= 1, 'staff actions counted');
  assert.ok(r.byMember >= 1, 'member submissions counted');
  assert.equal(r.total, r.entries.length);
});

// ------------------------------------------------------------ the document

test('the PDF renders, and is a PDF', async () => {
  const now = new Date();
  const { pdf, filename } = await report.buildForMonth(
    now.getUTCFullYear(), now.getUTCMonth() + 1);
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
  assert.ok(pdf.length > 800, 'and not an empty one');
  assert.match(filename, /^unplug-activity-\d{4}-\d{2}\.pdf$/);
});

test('a month with nothing in it still produces a document', async () => {
  // "Nothing happened" is itself a record, and a missing file looks like a
  // failure rather than a quiet month.
  const { pdf, report: r } = await report.buildForMonth(2020, 1);
  assert.equal(r.total, 0);
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
});

// ------------------------------------------------------------- sent once

test('THE REPORT IS SENT ONCE, EVEN ACROSS RESTARTS', async () => {
  // Render restarts on every deploy and whenever the free instance sleeps. A
  // scheduler that remembered in memory would resend all month.
  const { year, month } = report.previousMonth();
  const stamp = `${year}-${String(month).padStart(2, '0')}`;

  const first = await scheduler.due();
  assert.ok(first, 'it should be due before it has been sent');
  assert.equal(first.stamp, stamp);

  // Simulate the send having happened.
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ($1,$2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [scheduler.SETTING_KEY, stamp]);

  const second = await scheduler.due();
  assert.equal(second, null, 'having sent it, it is no longer due');
});

test('a new month becomes due again', async () => {
  // The stamp is the month, not a boolean, so October becomes due once
  // September has been sent.
  const nextMonth = new Date(Date.UTC(2099, 5, 15));
  const d = await scheduler.due(nextMonth);
  assert.ok(d, 'a month that has not been sent is due');
  assert.equal(d.stamp, '2099-05');
});

test('the recipient is configurable without a deploy', () => {
  assert.equal(scheduler.DEFAULT_RECIPIENT, 'info@unplugnews.com');
  assert.ok(scheduler.RECIPIENT_KEY, 'and a settings key overrides it');
});

test('A MONTH IS NEVER MARKED SENT WHEN NOTHING WAS SENT', async () => {
  // No email provider is configured in tests — which is exactly the state a
  // server is in before RESEND_API_KEY is set. sendEmail logs the message and
  // returns { simulated: true } rather than throwing, so the naive version of
  // this scheduler wrote "already sent" for a month that never went anywhere:
  // the record would look delivered, and nobody would find out until they went
  // looking for a report they believed they had.
  await pool.query('DELETE FROM settings WHERE key = $1', [scheduler.SETTING_KEY]);

  await assert.rejects(
    () => scheduler.sendFor(2021, 3),
    /no email provider/i,
    'it should say so rather than pretend');

  const mark = await pool.query('SELECT value FROM settings WHERE key = $1',
    [scheduler.SETTING_KEY]);
  assert.equal(mark.rows.length, 0, 'and must not record it as sent');

  assert.ok(await scheduler.due(), 'so the month is still owed');
});
