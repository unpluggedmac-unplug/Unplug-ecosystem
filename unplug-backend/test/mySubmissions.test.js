// The shared "My Unplug" pattern (spec §4).
//
// §4 asks for My Submissions plus My Articles / Events / Listings / Advertising
// / Competitions. Those are one list with a filter, not six features, and the
// point of utils/mySubmissions.js is that they cannot drift apart.
//
// What these protect, in order of how much they would hurt:
//
//   1. OWNERSHIP. Every type reaches its owner by a different route through the
//      schema — author_user_id, organizer_user_id, through advertisers, through
//      the member's profile. Five queries, five chances to show one member
//      another member's submissions. Each type is tested with two members.
//   2. ONE SHAPE. Every type returns the same keys, so one renderer can draw
//      all of them. A type that quietly omits a field breaks the section that
//      displays it, not this file.
//   3. THE FILTER ACTUALLY FILTERS. ?type=event returning everything would show
//      a member the wrong list while looking like it worked.
//   4. THE STATUS WORDING IS SHARED, so a status cannot be worded one way on My
//      Articles and another on My Events.

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
let tokenA;
let tokenB;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-mysubs-'));
const port = 50400 + (process.pid % 300);

const A = 940001; // the member whose things these are
const B = 940002; // another member, who must never see A's

async function api(urlPath, token) {
  const res = await fetch(baseUrl + urlPath, {
    headers: token ? { Authorization: 'Bearer ' + token } : {},
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
  process.env.JWT_SECRET = 'test-secret-my-submissions';
  process.env.UNPLUG_DISABLE_RATE_LIMITS = '1';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(dir, f), 'utf8'));
  }

  // Safe now: DATABASE_URL is set, so src/db.js builds a pool that works.
  ({ SUBMISSION_TYPES, STATUS_LABEL, statusLabel } = require('../src/utils/mySubmissions'));

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
     VALUES ($1, 'a@subs.test', 'Member A', 'x', 'member'),
            ($2, 'b@subs.test', 'Member B', 'x', 'member')`, [A, B]);
  tokenA = jwt.sign({ id: A, email: 'a@subs.test', role: 'member' }, process.env.JWT_SECRET);
  tokenB = jwt.sign({ id: B, email: 'b@subs.test', role: 'member' }, process.env.JWT_SECRET);

  // One submission of every type for each member, so ownership is tested from
  // both sides rather than only proving A can see their own.
  for (const [user, tag] of [[A, 'A'], [B, 'B']]) {
    const prof = await pool.query(
      `INSERT INTO profiles (user_id, display_name, slug, package_tier, status)
       VALUES ($1, $2, $3, 'basic', 'approved') RETURNING id`,
      [user, `Profile ${tag}`, `profile-${tag.toLowerCase()}`]);
    const profileId = prof.rows[0].id;

    const adv = await pool.query(
      `INSERT INTO advertisers (user_id, business_name) VALUES ($1, $2) RETURNING id`,
      [user, `Advertiser ${tag}`]);

    const comp = await pool.query(
      `INSERT INTO competitions (name, slug, opens_at, closes_at, status)
       VALUES ($1, $2, now() - interval '1 day', now() + interval '30 days', 'open')
       RETURNING id`, [`Comp ${tag}`, `comp-${tag.toLowerCase()}`]);

    await pool.query(
      `INSERT INTO articles (author_user_id, title, body, status)
       VALUES ($1, $2, 'body', 'pending')`, [user, `Article ${tag}`]);
    await pool.query(
      `INSERT INTO events (organizer_user_id, name, event_date, status)
       VALUES ($1, $2, CURRENT_DATE + 10, 'approved')`, [user, `Event ${tag}`]);
    await pool.query(
      // duration_days is 30 exactly — migration 010 narrowed the CHECK from the
      // original 7/14/21/28 to a single supported duration.
      `INSERT INTO marketplace_listings (advertiser_id, poster_image_url, headline, duration_days, status)
       VALUES ($1, 'http://x/p.jpg', $2, 30, 'approved')`, [adv.rows[0].id, `Listing ${tag}`]);
    await pool.query(
      `INSERT INTO ad_slots (slot_key, image_url, name, owner_user_id, moderation_status)
       VALUES ($1, 'http://x/a.jpg', $2, $3, 'pending')`,
      [`slot-${tag.toLowerCase()}`, `Advert ${tag}`, user]);
    await pool.query(
      `INSERT INTO competition_entries (competition_id, profile_id, status)
       VALUES ($1, $2, 'approved')`, [comp.rows[0].id, profileId]);
    await pool.query(
      `INSERT INTO gallery_bundles (user_id, image_count, status)
       VALUES ($1, 2, 'pending')`, [user]);
  }
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
});

// Loaded in before(), NOT at the top of the file. Requiring it here would pull
// in src/db.js and build its pool while DATABASE_URL is still unset; Node caches
// that dead pool, the route then receives the same one, and every query hangs
// until the test times out rather than failing with anything readable.
// SUBMISSION_TYPES, not every type the shared pattern knows. My Services later
// added highlights and the directory listing to TYPES; this section must keep
// showing exactly what it showed before, which is what these assert.
let SUBMISSION_TYPES;
let STATUS_LABEL;
let statusLabel;

// ---------------------------------------------------------------- ownership

test('A MEMBER SEES ONLY THEIR OWN SUBMISSIONS, OF EVERY TYPE', async () => {
  // The one that matters. Each type reaches its owner by a different route
  // through the schema, so each is a separate chance to leak.
  const res = await api('/my/submissions', tokenA);
  assert.equal(res.status, 200);

  const titles = res.body.submissions.map((s) => s.title).join(' | ');
  assert.ok(!/ B\b/.test(titles), `member A must not see member B's work: ${titles}`);

  const types = new Set(res.body.submissions.map((s) => s.type));
  assert.deepEqual([...types].sort(), [...SUBMISSION_TYPES].sort(),
    'every type should be represented, or a type is silently missing from the menu');
});

test('...and the same is true from the other side', async () => {
  const res = await api('/my/submissions', tokenB);
  const titles = res.body.submissions.map((s) => s.title).join(' | ');
  assert.ok(!/ A\b/.test(titles), `member B must not see member A's work: ${titles}`);
});

test('every type is owned separately — checked one type at a time', async () => {
  // The all-types query could pass while one branch leaks, if another branch
  // happened to filter it out. This checks each route through the schema alone.
  for (const type of SUBMISSION_TYPES) {
    const res = await api(`/my/submissions?type=${type}`, tokenA);
    assert.equal(res.status, 200, type);
    assert.ok(res.body.submissions.length > 0, `${type} should return A's own row`);
    for (const row of res.body.submissions) {
      assert.equal(row.type, type, 'the filter must return only what was asked for');
      assert.ok(!/ B\b/.test(String(row.title)), `${type} leaked member B's row`);
    }
  }
});

test('signing out is not optional', async () => {
  const res = await api('/my/submissions', null);
  assert.equal(res.status, 401);
});

// ----------------------------------------------------------------- one shape

test('EVERY TYPE RETURNS THE SAME SHAPE', async () => {
  // One renderer draws all of them, so a type that omits a key breaks the
  // section rather than this file. Caught here instead.
  const expected = ['type', 'typeLabel', 'id', 'title', 'status', 'statusLabel',
    'submittedAt', 'expiresAt', 'amount', 'paymentStatus', 'reference'].sort();

  const res = await api('/my/submissions', tokenA);
  const seen = new Set();
  for (const row of res.body.submissions) {
    assert.deepEqual(Object.keys(row).sort(), expected, `${row.type} has a different shape`);
    seen.add(row.type);
  }
  assert.equal(seen.size, SUBMISSION_TYPES.length, 'every type should have been exercised');
});

test('every row carries a title a member can actually read', async () => {
  // A blank row is indistinguishable from a broken one. Gallery and listings
  // have no natural title, so both are given one rather than left empty.
  const res = await api('/my/submissions', tokenA);
  for (const row of res.body.submissions) {
    assert.ok(row.title && String(row.title).trim().length > 0,
      `${row.type} returned an empty title`);
  }
});

test('newest first, across all types at once', async () => {
  const res = await api('/my/submissions', tokenA);
  const dates = res.body.submissions.map((s) => new Date(s.submittedAt).getTime());
  const sorted = [...dates].sort((x, y) => y - x);
  assert.deepEqual(dates, sorted);
});

// -------------------------------------------------------------- the filter

test('THE FILTER ACTUALLY FILTERS', async () => {
  const all = await api('/my/submissions', tokenA);
  const events = await api('/my/submissions?type=event', tokenA);

  assert.ok(events.body.submissions.length < all.body.submissions.length,
    'a filtered list that is the same size as the whole list is not filtering');
  assert.ok(events.body.submissions.every((s) => s.type === 'event'));
});

test('an unknown type is refused, not quietly ignored', async () => {
  // Silently returning everything would show a member the wrong list while
  // looking like it had worked.
  const res = await api('/my/submissions?type=not_a_service', tokenA);
  assert.equal(res.status, 400);
  assert.ok(Array.isArray(res.body.known), 'the error should say what is valid');
});

// ------------------------------------------------------------ status wording

test('THE STATUS WORDING COMES FROM ONE PLACE', async () => {
  const res = await api('/my/submissions', tokenA);
  for (const row of res.body.submissions) {
    assert.equal(row.statusLabel, statusLabel(row.status),
      'a section must not word a status differently from the shared map');
  }
});

test('no status is left to a fall-through default', async () => {
  // The highlights dashboard once ended a credited submission with "Active",
  // because its label chain fell through. Every status the vocabulary allows
  // must have a deliberate word.
  const { STATUSES } = require('../src/utils/submissionStatus');
  const missing = Object.keys(STATUSES).filter(
    (s) => !Object.prototype.hasOwnProperty.call(STATUS_LABEL, s));
  assert.deepEqual(missing, [],
    `these statuses have no member-facing wording: ${missing.join(', ')}`);
});

test('an unknown status is shown as itself rather than guessed at', async () => {
  assert.equal(statusLabel('something_new'), 'something_new');
});

// ------------------------------------------------------------------ the menu

test('the menu is built from the same list the data comes from', async () => {
  const res = await api('/my/submission-types', tokenA);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.types.map((t) => t.type).sort(), [...SUBMISSION_TYPES].sort());
  for (const t of res.body.types) {
    assert.ok(t.label && t.plural, `${t.type} needs both a label and a plural`);
  }
});

test('a member with nothing gets an empty list, not an error', async () => {
  const jwt = require('jsonwebtoken');
  await pool.query(
    `INSERT INTO users (id, email, full_name, password_hash, role)
     VALUES (940003, 'empty@subs.test', 'Empty', 'x', 'member')`);
  const token = jwt.sign({ id: 940003, email: 'empty@subs.test', role: 'member' },
    process.env.JWT_SECRET);
  const res = await api('/my/submissions', token);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.submissions, []);
});
