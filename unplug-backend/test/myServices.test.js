// My Services (spec §5): active · pending · expiring · expired ·
//                        requiring changes · awaiting payment
//
// The same data as My Submissions, read by term rather than by review. What
// these protect:
//
//   1. THE BUCKETS ARE RIGHT. A member decides whether to pay from these. A
//      service shown as Active when it expired yesterday means a listing they
//      think is running is not; one shown as Expired when it has a month left
//      means paying twice.
//   2. THE BOUNDARIES. Expiring is a window, and windows have edges: today,
//      the last day inside it, and the first day outside.
//   3. COMPETITIONS ARE NOT SERVICES and must not appear here.
//   4. STATUS BEATS DATES. A service awaiting payment is not Active however
//      good its dates look.
//   5. NOTHING IS SILENTLY DROPPED. Every service the member has lands in
//      exactly one bucket.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const EmbeddedPostgres = require('embedded-postgres').default;
const { stopPostgres } = require('./helpers/stopPostgres');
const { ensureStopWords } = require('./helpers/textSearch');

// Required in before(), after DATABASE_URL is set — requiring it here would
// build src/db.js's pool with no connection string, and every query would hang.
let mine;

let pg;
let pool;
let server;
let baseUrl;
let token;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-mysvc-'));
const port = 50800 + (process.pid % 300);
const ME = 950001;
const OTHER = 950002;

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
  process.env.JWT_SECRET = 'test-secret-my-services';
  process.env.UNPLUG_DISABLE_RATE_LIMITS = '1';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(dir, f), 'utf8'));
  }

  mine = require('../src/utils/mySubmissions');

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
     VALUES ($1,'me@svc.test','Me','x','member'), ($2,'other@svc.test','Other','x','member')`,
    [ME, OTHER]);
  token = jwt.sign({ id: ME, email: 'me@svc.test', role: 'member' }, process.env.JWT_SECRET);
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
});

// ------------------------------------------------------- the bucketing rules
//
// Tested directly as well as through the route: these are the rules a member
// reads, and a unit test says which rule broke rather than which page looked odd.

const TODAY = '2026-09-02';

test('AN APPROVED SERVICE WITH A MONTH LEFT IS ACTIVE', () => {
  assert.equal(mine.bucketFor({ status: 'approved', expiresAt: '2026-12-01' }, TODAY), 'active');
});

test('...and one ending inside the window is EXPIRING, not active', () => {
  assert.equal(mine.bucketFor({ status: 'approved', expiresAt: '2026-09-20' }, TODAY), 'expiring');
});

test('...and one that has already ended is EXPIRED', () => {
  assert.equal(mine.bucketFor({ status: 'approved', expiresAt: '2026-08-20' }, TODAY), 'expired');
});

test('A SERVICE ENDING TODAY HAS NOT EXPIRED', () => {
  // Compared as calendar days. Treating "now" as a moment expires a service
  // part-way through its own last day — the mistake multi-day events made.
  assert.equal(mine.bucketFor({ status: 'approved', expiresAt: TODAY }, TODAY), 'expiring');
});

test('the edges of the expiring window are where they claim to be', () => {
  const day = (n) => {
    const d = new Date(Date.parse(TODAY + 'T00:00:00Z') + n * 86400000);
    return d.toISOString().slice(0, 10);
  };
  const w = mine.EXPIRING_WITHIN_DAYS;
  assert.equal(mine.bucketFor({ status: 'approved', expiresAt: day(w) }, TODAY), 'expiring',
    'the last day inside the window is still expiring');
  assert.equal(mine.bucketFor({ status: 'approved', expiresAt: day(w + 1) }, TODAY), 'active',
    'the first day outside it is active');
  assert.equal(mine.bucketFor({ status: 'approved', expiresAt: day(-1) }, TODAY), 'expired',
    'yesterday is expired');
});

test('a service with NO term is active, not expiring', () => {
  // An article stays published; there is nothing to renew.
  assert.equal(mine.bucketFor({ status: 'approved', expiresAt: null }, TODAY), 'active');
});

test('STATUS BEATS DATES', () => {
  // A service awaiting payment is not running, however good its dates look.
  const future = { expiresAt: '2026-12-01' };
  assert.equal(mine.bucketFor({ ...future, status: 'awaiting_payment' }, TODAY), 'awaiting_payment');
  assert.equal(mine.bucketFor({ ...future, status: 'changes_requested' }, TODAY), 'requiring_changes');
  assert.equal(mine.bucketFor({ ...future, status: 'pending' }, TODAY), 'pending');
  assert.equal(mine.bucketFor({ ...future, status: 'resubmitted' }, TODAY), 'pending');
});

test('anything that ended badly is over, whatever its dates say', () => {
  const future = { expiresAt: '2026-12-01' };
  for (const status of ['rejected', 'credit_issued', 'expired', 'draft']) {
    assert.equal(mine.bucketFor({ ...future, status }, TODAY), 'expired', status);
  }
});

test('every status the vocabulary allows lands in a real bucket', () => {
  // A status with no bucket would be dropped from the page entirely.
  const { STATUSES } = require('../src/utils/submissionStatus');
  for (const status of Object.keys(STATUSES)) {
    const bucket = mine.bucketFor({ status, expiresAt: null }, TODAY);
    assert.ok(mine.SERVICE_BUCKETS.includes(bucket), `${status} -> ${bucket}`);
  }
});

// --------------------------------------------------------------- the route

async function seedServices() {
  const prof = await pool.query(
    `INSERT INTO profiles (user_id, display_name, slug, package_tier, status, renews_at)
     VALUES ($1,'My Listing','my-listing','basic','approved', now() + interval '200 days')
     RETURNING id`, [ME]);
  const adv = await pool.query(
    `INSERT INTO advertisers (user_id, business_name) VALUES ($1,'Adv') RETURNING id`, [ME]);
  const comp = await pool.query(
    `INSERT INTO competitions (name, slug, opens_at, closes_at, status)
     VALUES ('Comp','svc-comp', now() - interval '1 day', now() + interval '30 days','open')
     RETURNING id`);

  // One in each interesting state.
  await pool.query(`INSERT INTO articles (author_user_id,title,body,status)
                    VALUES ($1,'Published article','b','approved')`, [ME]);
  await pool.query(`INSERT INTO events (organizer_user_id,name,event_date,end_date,status)
                    VALUES ($1,'Event next year', CURRENT_DATE + 300, CURRENT_DATE + 302,'approved')`, [ME]);
  await pool.query(`INSERT INTO events (organizer_user_id,name,event_date,status)
                    VALUES ($1,'Event soon', CURRENT_DATE + 5,'approved')`, [ME]);
  await pool.query(`INSERT INTO events (organizer_user_id,name,event_date,status)
                    VALUES ($1,'Event long gone', CURRENT_DATE - 60,'approved')`, [ME]);
  await pool.query(`INSERT INTO marketplace_listings
                    (advertiser_id,poster_image_url,headline,duration_days,status,active_to)
                    VALUES ($1,'http://x/p.jpg','Listing awaiting',30,'awaiting_payment', CURRENT_DATE + 20)`,
  [adv.rows[0].id]);
  await pool.query(`INSERT INTO ad_slots (slot_key,image_url,name,owner_user_id,moderation_status,ends_at)
                    VALUES ('svc-ad','http://x/a.jpg','My advert',$1,'pending', CURRENT_DATE + 40)`, [ME]);
  await pool.query(`INSERT INTO gallery_bundles (user_id,image_count,status)
                    VALUES ($1,2,'approved')`, [ME]);
  await pool.query(`INSERT INTO highlights (target_type,target_id,duration_days,status,end_date)
                    VALUES ('directory',$1,28,'approved', CURRENT_DATE + 3)`, [prof.rows[0].id]);
  // A competition entry, which must NOT appear in services.
  await pool.query(`INSERT INTO competition_entries (competition_id,profile_id,status)
                    VALUES ($1,$2,'approved')`, [comp.rows[0].id, prof.rows[0].id]);
}

test('GET /my/services returns §5\'s six buckets, in reading order', async () => {
  await seedServices();
  const res = await api('/my/services', token);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.groups.map((g) => g.key), mine.SERVICE_BUCKETS);
  assert.equal(res.body.expiringWithinDays, mine.EXPIRING_WITHIN_DAYS);
  assert.ok(res.body.today, 'the database\'s today should be reported');
});

test('COMPETITIONS ARE NOT SERVICES', async () => {
  // An entry is not bought for a period and cannot be renewed.
  const res = await api('/my/services', token);
  const all = res.body.groups.flatMap((g) => g.services);
  assert.equal(all.filter((s) => s.type === 'competition').length, 0);

  // …and it is still in My Submissions, where it belongs.
  const subs = await api('/my/submissions?type=competition', token);
  assert.ok(subs.body.submissions.length > 0, 'the entry should not have vanished entirely');
});

test('a service lands in exactly one bucket, and none is lost', async () => {
  const res = await api('/my/services', token);
  const all = res.body.groups.flatMap((g) => g.services);
  const ids = all.map((s) => `${s.type}:${s.id}`);
  assert.equal(new Set(ids).size, ids.length, 'a service appears twice');

  const listed = await api('/my/submissions', token);
  const expectedTypes = new Set(mine.SERVICE_TYPES);
  const shouldAppear = listed.body.submissions.filter((s) => expectedTypes.has(s.type)).length;
  assert.ok(all.length >= shouldAppear,
    'every service type shown in submissions should also reach services');
});

test('the seeded services land where a member would expect', async () => {
  const res = await api('/my/services', token);
  const where = {};
  for (const g of res.body.groups) for (const s of g.services) where[s.title] = g.key;

  assert.equal(where['Event next year'], 'active', 'a year out is active');
  assert.equal(where['Event soon'], 'expiring', 'five days out is expiring');
  assert.equal(where['Event long gone'], 'expired');
  assert.equal(where['Listing awaiting'], 'awaiting_payment', 'status beats its future date');
  assert.equal(where['Published article'], 'active', 'no term, so simply active');
  assert.equal(where['My advert'], 'pending', 'moderation_status pending');
  assert.equal(where['My Listing'], 'active', 'directory package renewing in 200 days');
});

test('a highlight reaches its owner through the profile it points at', async () => {
  // Highlights have no owner column — the owner is whoever owns the target.
  const res = await api('/my/services', token);
  const all = res.body.groups.flatMap((g) => g.services);
  const hl = all.filter((s) => s.type === 'highlight');
  assert.equal(hl.length, 1, 'the highlight on my own profile should be mine');
  assert.equal(hl[0].statusLabel, 'Approved');
});

test('ANOTHER MEMBER SEES NONE OF IT', async () => {
  const jwt = require('jsonwebtoken');
  const otherToken = jwt.sign({ id: OTHER, email: 'other@svc.test', role: 'member' },
    process.env.JWT_SECRET);
  const res = await api('/my/services', otherToken);
  const all = res.body.groups.flatMap((g) => g.services);
  assert.deepEqual(all, [], 'a member with no services must see an empty set, not mine');
});

test('signed out is refused', async () => {
  const res = await api('/my/services', null);
  assert.equal(res.status, 401);
});

test('empty buckets are still returned, so the page can say "nothing here"', async () => {
  const res = await api('/my/services', token);
  assert.equal(res.body.groups.length, mine.SERVICE_BUCKETS.length,
    'a missing bucket leaves a silent gap on the page');
});

// ------------------------------------------- My Submissions is unchanged

test('ADDING SERVICE TYPES DID NOT CHANGE MY SUBMISSIONS', async () => {
  // highlights and the directory profile were added to the shared TYPES for
  // this section. My Submissions must show exactly what it showed before.
  const res = await api('/my/submissions', token);
  const types = new Set(res.body.submissions.map((s) => s.type));
  for (const t of types) {
    assert.ok(mine.SUBMISSION_TYPES.includes(t), `${t} leaked into My Submissions`);
  }
  assert.ok(!types.has('highlight'), 'highlights belong to My Services');
  assert.ok(!types.has('profile'), 'the directory listing belongs to My Services');
});

test('a type outside a menu item\'s own set is refused there', async () => {
  const res = await api('/my/submissions?type=highlight', token);
  assert.equal(res.status, 400, 'highlight is a service, not a submission filter');
});
