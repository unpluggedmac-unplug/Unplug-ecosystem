// Popups, against a REAL PostgreSQL and a real HTTP server.
//
// This is the only feature here whose purpose is to get in somebody's way, so
// what these tests protect is mostly the reader:
//
//   1. A POPUP IS OFF UNTIL SOMEBODY SWITCHES IT ON. One half-written on a
//      Tuesday must not be interrupting readers on Wednesday.
//   2. AN EXPIRED POPUP STOPS ON ITS OWN. Nothing should still be shouting
//      about a deadline that passed in March.
//   3. THE PUBLIC FEED HANDS OUT NOTHING PRIVATE. It is an unauthenticated
//      endpoint reading an admin-managed table.
//   4. THE EVENT ENDPOINT CANNOT BE USED TO FILL THE DATABASE with rows for
//      popups that do not exist.
//   5. THE NUMBERS INCLUDE THE DISMISSALS. Impressions and conversions alone
//      make every popup look like a success.
//
// And one that is about the mailing list rather than the popup: a signup now
// records consent, because before this the site's only newsletter form wrote
// to a table no campaign reads.
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
let adminToken;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-popups-'));
const port = 41200 + (process.pid % 300); // bases are 400 apart so ranges cannot overlap

async function api(method, urlPath, body, token) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
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
  process.env.JWT_SECRET = 'test-secret-for-popups';
  process.env.UNPLUG_DISABLE_RATE_LIMITS = '1';
  delete process.env.RESEND_API_KEY;
  delete process.env.BREVO_API_KEY;

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations'))
    .filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }

  const emailUtil = require('../src/utils/email');
  emailUtil.sendEmail = async () => ({ provider: 'test' });

  const jwt = require('jsonwebtoken');
  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(require('../src/middleware/requestContext').middleware);
  app.use(attachUser);
  app.use('/popups', require('../src/routes/popups'));
  app.use('/newsletter', require('../src/routes/newsletter'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await pool.query(`INSERT INTO users (id, email, full_name, password_hash, role)
                    VALUES (880001, 'popadmin@test.com', 'Pop Admin', 'x', 'admin')`);
  adminToken = jwt.sign({ id: 880001, email: 'popadmin@test.com', role: 'admin' }, process.env.JWT_SECRET);
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
});

const create = (extra = {}) => api('POST', '/popups',
  { name: 'Test popup', title: 'Join us', ...extra }, adminToken);

const activeIds = async () => (await api('GET', '/popups/active')).body.map((p) => p.id);

// ---------------------------------------------------------------------------
// Off by default
// ---------------------------------------------------------------------------

test('A NEW POPUP IS OFF, and does not appear to readers', async () => {
  const made = await create({ name: 'Half written' });
  assert.equal(made.status, 201);
  assert.equal(made.body.active, false, 'created switched off');
  assert.ok(!(await activeIds()).includes(made.body.id), 'and the public feed does not carry it');
});

test('switching it on is what makes it appear', async () => {
  const made = await create({ name: 'Ready to go' });
  await api('PATCH', '/popups/' + made.body.id, { active: true }, adminToken);
  assert.ok((await activeIds()).includes(made.body.id));
});

test('AN EXPIRED POPUP STOPS ON ITS OWN', async () => {
  // Otherwise the failure mode is not a bug anybody reports — it is a
  // competition popup still counting down to a date that passed in March, and
  // a site that looks abandoned.
  const made = await create({ name: 'Competition closed' });
  await api('PATCH', '/popups/' + made.body.id, {
    active: true,
    startsAt: new Date(Date.now() - 7 * 86400000).toISOString(),
    endsAt: new Date(Date.now() - 86400000).toISOString(),
  }, adminToken);
  assert.ok(!(await activeIds()).includes(made.body.id), 'past its end date, so not served');
});

test('a popup scheduled for next week is not served today', async () => {
  const made = await create({ name: 'Next week' });
  await api('PATCH', '/popups/' + made.body.id, {
    active: true, startsAt: new Date(Date.now() + 7 * 86400000).toISOString(),
  }, adminToken);
  assert.ok(!(await activeIds()).includes(made.body.id));
});

// ---------------------------------------------------------------------------
// The public feed
// ---------------------------------------------------------------------------

test('THE PUBLIC FEED HANDS OUT NOTHING PRIVATE', async () => {
  const made = await create({ name: 'Internal name nobody should see' });
  await api('PATCH', '/popups/' + made.body.id, { active: true }, adminToken);

  const res = await api('GET', '/popups/active');
  const row = res.body.find((p) => p.id === made.body.id);
  assert.ok(row, 'it is served');
  // The internal name, who made it and when are the admin's view of the
  // record. A public endpoint should not hand those out just because the
  // popup itself is public.
  for (const field of ['name', 'created_by', 'created_at', 'updated_at', 'active']) {
    assert.equal(row[field], undefined, `${field} is not exposed`);
  }
  assert.equal(row.title, 'Join us', 'but what is needed to draw it is');
});

test('the feed is cacheable, because every page view asks for it', async () => {
  const res = await api('GET', '/popups/active');
  assert.match(res.headers.get('cache-control') || '', /max-age=\d+/);
});

test('the feed needs no login', async () => {
  const res = await api('GET', '/popups/active');   // no token
  assert.equal(res.status, 200);
});

test('a reader cannot create, change or delete one', async () => {
  assert.equal((await api('POST', '/popups', { name: 'x', title: 'y' })).status, 401);
  assert.equal((await api('PATCH', '/popups/1', { active: true })).status, 401);
  assert.equal((await api('DELETE', '/popups/1')).status, 401);
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

test('THE EVENT ENDPOINT CANNOT BE FILLED WITH ROWS FOR POPUPS THAT DO NOT EXIST', async () => {
  const before = (await pool.query('SELECT count(*)::int AS n FROM popup_events')).rows[0].n;
  await api('POST', '/popups/999999/event', { kind: 'impression' });
  const after = (await pool.query('SELECT count(*)::int AS n FROM popup_events')).rows[0].n;
  assert.equal(after, before, 'nothing recorded against an id that is not real');
});

test('an unknown event kind is refused', async () => {
  const made = await create();
  const res = await api('POST', '/popups/' + made.body.id + '/event', { kind: 'purchased-a-yacht' });
  assert.equal(res.status, 400);
});

test('THE NUMBERS INCLUDE THE DISMISSALS', async () => {
  // Impressions and conversions alone make every popup look like a success:
  // seen a thousand times, signed up twelve people. The number that decides
  // whether it should exist is how many were interrupted and closed it.
  const made = await create({ name: 'Measured' });
  const id = made.body.id;
  for (let i = 0; i < 10; i += 1) await api('POST', `/popups/${id}/event`, { kind: 'impression', page: 'news' });
  for (let i = 0; i < 7; i += 1) await api('POST', `/popups/${id}/event`, { kind: 'dismiss', page: 'news' });
  await api('POST', `/popups/${id}/event`, { kind: 'convert', page: 'news' });

  const report = await api('GET', `/popups/${id}/report`, null, adminToken);
  assert.equal(report.body.totals.impressions, 10);
  assert.equal(report.body.totals.dismissals, 7);
  assert.equal(report.body.totals.conversions, 1);
  assert.equal(report.body.rates.conversion, 10);
  assert.equal(report.body.rates.dismissal, 70, 'and the cost is reported, not buried');
  assert.match(report.body.caveat, /dismissal rate/i);
});

test('the report breaks the numbers down by page', async () => {
  const made = await create({ name: 'Per page' });
  const id = made.body.id;
  await api('POST', `/popups/${id}/event`, { kind: 'impression', page: 'home' });
  await api('POST', `/popups/${id}/event`, { kind: 'impression', page: 'articledetail' });
  await api('POST', `/popups/${id}/event`, { kind: 'convert', page: 'articledetail' });

  const report = await api('GET', `/popups/${id}/report`, null, adminToken);
  const article = report.body.byPage.find((r) => r.page === 'articledetail');
  assert.equal(article.conversions, 1);
});

// ---------------------------------------------------------------------------
// Values that would produce a bad popup are clamped, not trusted
// ---------------------------------------------------------------------------

test('a popup cannot be made to fire the instant somebody arrives', async () => {
  // scroll_percent 0 means interrupting a reader before they have seen
  // anything worth staying for, which is the most reliable way to lose them.
  const made = await create({ name: 'Too eager', scrollPercent: 0 });
  assert.ok(made.body.scroll_percent >= 5);
});

test('nonsense values are clamped rather than stored', async () => {
  const made = await create({ name: 'Odd', scrollPercent: 5000, frequencyDays: -12 });
  assert.equal(made.body.scroll_percent, 100);
  assert.ok(made.body.frequency_days >= 1);
});

test('an unknown kind falls back to newsletter rather than being stored', async () => {
  const made = await create({ name: 'Mystery', kind: 'interpretive-dance' });
  assert.equal(made.body.kind, 'newsletter');
});

// ---------------------------------------------------------------------------
// The newsletter consent gap this feature sits on top of
// ---------------------------------------------------------------------------

test('A NEWSLETTER SIGNUP NOW RECORDS CONSENT AND JOINS THE LIST', async () => {
  // Before this, /newsletter/subscribe wrote only to newsletter_subscribers.
  // Migration 141 imported whoever existed the day it ran, but every signup
  // after that landed in the old table alone — on no mailing list, with no
  // record of where the consent came from. A campaign sent to "The Friday
  // newsletter" reached none of them, and the gap widened by one person per
  // signup, invisibly.
  const res = await api('POST', '/newsletter/subscribe',
    { email: 'Joiner@Example.com', source: 'popup: Join us' });
  assert.equal(res.status, 201);

  const legacy = await pool.query(
    `SELECT count(*)::int AS n FROM newsletter_subscribers WHERE email = 'joiner@example.com'`);
  assert.equal(legacy.rows[0].n, 1, 'the old table is still written, so nothing that reads it breaks');

  const sub = await pool.query(`
    SELECT s.status, s.consent_source, l.slug
      FROM email_subscriptions s JOIN email_lists l ON l.id = s.list_id
     WHERE LOWER(s.email) = 'joiner@example.com'`);
  assert.equal(sub.rowCount, 1, 'and they are on a real mailing list now');
  assert.equal(sub.rows[0].slug, 'newsletter');
  assert.equal(sub.rows[0].status, 'subscribed');
  assert.equal(sub.rows[0].consent_source, 'popup: Join us',
    'with an honest answer to "why do you have my address"');
});

test('a signup with no source still records where it came from, honestly', async () => {
  await api('POST', '/newsletter/subscribe', { email: 'nosource@example.com' });
  const r = await pool.query(
    `SELECT consent_source FROM email_subscriptions WHERE LOWER(email) = 'nosource@example.com'`);
  assert.equal(r.rows[0].consent_source, 'newsletter form');
});

test('subscribing twice does not create two records', async () => {
  await api('POST', '/newsletter/subscribe', { email: 'twice@example.com' });
  await api('POST', '/newsletter/subscribe', { email: 'twice@example.com' });
  const r = await pool.query(
    `SELECT count(*)::int AS n FROM email_subscriptions WHERE LOWER(email) = 'twice@example.com'`);
  assert.equal(r.rows[0].n, 1);
});

test('a rubbish address is refused before anything is written', async () => {
  const res = await api('POST', '/newsletter/subscribe', { email: 'not-an-address' });
  assert.equal(res.status, 400);
  const r = await pool.query(
    `SELECT count(*)::int AS n FROM email_subscriptions WHERE email = 'not-an-address'`);
  assert.equal(r.rows[0].n, 0);
});

// ---------------------------------------------------------------------------
// Deleting
// ---------------------------------------------------------------------------

test('deleting a popup takes its events with it rather than orphaning them', async () => {
  const made = await create({ name: 'Doomed' });
  await api('POST', `/popups/${made.body.id}/event`, { kind: 'impression' });
  await api('DELETE', '/popups/' + made.body.id, null, adminToken);
  const r = await pool.query('SELECT count(*)::int AS n FROM popup_events WHERE popup_id = $1',
    [made.body.id]);
  assert.equal(r.rows[0].n, 0);
});
