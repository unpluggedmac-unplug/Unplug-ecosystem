// Ad banner purchases, tested against a REAL PostgreSQL.
//
// This route takes money, and the things worth pinning down are the ones a
// reader of the code has to take on trust:
//
//   1. the price quoted on the buy form and the price returned at submission
//      come from the SAME admin-managed table — the bug this route was written
//      to prevent is a form advertising R500 while checkout charges R750;
//   2. a package an admin has switched off cannot be bought by re-posting an
//      older form, which is the obvious way round a price change;
//   3. a new banner is never live — it starts inactive and pending_payment, so
//      nothing appears on the public site before it has been paid for AND
//      approved;
//   4. the placement list is server-side, so a client cannot invent a slot;
//   5. /mine shows you your own banners and nobody else's.
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
let jwt;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-adbanner-'));
const port = 31200 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

async function req(method, urlPath, { token, body } = {}) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, body: json };
}

function tokenFor(userId, role = 'member') {
  return jwt.sign({ id: userId, email: `ab${userId}@test.com`, role }, process.env.JWT_SECRET);
}

let _nextUserId = 331000;
async function makeUser(role = 'member') {
  const id = _nextUserId++;
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', $3) ON CONFLICT DO NOTHING`,
    [id, `ab${id}@test.com`, role]
  );
  return id;
}

// A banner submission that is valid in every respect, so each test can change
// exactly the one field it is about.
function validBanner(over = {}) {
  return {
    slotKey: 'home-sponsor-1',
    durationDays: SALE_DURATION,
    imageUrl: 'https://example.com/banner.png',
    linkUrl: 'https://example.com',
    name: 'Test Sponsor',
    ...over,
  };
}

let memberId;
let memberToken;
// A duration that is genuinely on sale, read from the packages table rather
// than written in here — the price list is admin-managed and does change.
let SALE_DURATION;

before(async () => {
  pg = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'postgres', password: 'postgres', port,
    persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('unplug_test');

  process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${port}/unplug_test`;
  process.env.JWT_SECRET = 'test-secret-for-ad-banners';
  process.env.UNPLUG_DISABLE_RATE_LIMITS = '1';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }

  jwt = require('jsonwebtoken');

  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/ad-banners', require('../src/routes/adBanners'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  memberId = await makeUser();
  memberToken = tokenFor(memberId);

  const seeded = await pool.query(
    `SELECT duration_days FROM service_packages
      WHERE service_key = 'ad_banner' AND active ORDER BY display_order LIMIT 1`);
  SALE_DURATION = seeded.rows[0].duration_days;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  // stopPostgres, not pg.stop() directly: on Windows the library's stop
  // can HANG rather than throw, which used to leave the cluster running
  // with no parent and eventually broke a later test file's startup.
  // See test/helpers/stopPostgres.js.
  await stopPostgres(pg, dataDir);
});

// ---------------------------------------------------------------------------
// The price on the form is the price you are charged
// ---------------------------------------------------------------------------

test('THE QUOTED PRICE AND THE CHARGED PRICE COME FROM THE SAME ROW', async () => {
  // The whole reason this route reads service_packages instead of a constant.
  const opts = await req('GET', '/ad-banners/options');
  assert.equal(opts.status, 200);
  assert.ok(opts.body.durations.length > 0, 'there is at least one package on sale');

  const duration = opts.body.durations[0];
  const quoted = opts.body.prices[duration];
  assert.ok(quoted > 0, 'the form quotes a real price');

  const created = await req('POST', '/ad-banners', {
    token: memberToken, body: validBanner({ durationDays: duration }),
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.price, quoted,
    'the price returned for payment must equal the price the buyer was shown');
});

test('an admin price change moves the form and the charge together', async () => {
  const opts = await req('GET', '/ad-banners/options');
  const duration = opts.body.durations[0];
  const before = opts.body.prices[duration];

  await pool.query(
    `UPDATE service_packages SET price = price + 111
      WHERE service_key = 'ad_banner' AND duration_days = $1`, [duration]);

  const after = await req('GET', '/ad-banners/options');
  assert.equal(after.body.prices[duration], before + 111, 'the form shows the new price');

  const created = await req('POST', '/ad-banners', {
    token: memberToken, body: validBanner({ durationDays: duration }),
  });
  assert.equal(created.body.price, before + 111, 'and so does the charge');

  // Put it back so later tests read the seeded price.
  await pool.query(
    `UPDATE service_packages SET price = price - 111
      WHERE service_key = 'ad_banner' AND duration_days = $1`, [duration]);
});

test('a package the admin has switched off cannot be bought by re-posting an old form', async () => {
  // Someone who loaded the form yesterday still has the old duration in their
  // browser. Turning a package off has to actually stop the sale.
  const opts = await req('GET', '/ad-banners/options');
  const duration = opts.body.durations[0];

  await pool.query(
    `UPDATE service_packages SET active = false
      WHERE service_key = 'ad_banner' AND duration_days = $1`, [duration]);

  const rejected = await req('POST', '/ad-banners', {
    token: memberToken, body: validBanner({ durationDays: duration }),
  });
  assert.equal(rejected.status, 400, 'the sale is refused');
  assert.match(rejected.body.error, /available durations/i,
    'and the message says what IS available rather than just "no"');

  await pool.query(
    `UPDATE service_packages SET active = true
      WHERE service_key = 'ad_banner' AND duration_days = $1`, [duration]);
});

// ---------------------------------------------------------------------------
// Nothing goes live by being submitted
// ---------------------------------------------------------------------------

test('A NEW BANNER IS NOT LIVE — inactive and pending_payment', async () => {
  const created = await req('POST', '/ad-banners', { token: memberToken, body: validBanner() });
  assert.equal(created.status, 201);

  const row = await pool.query(
    'SELECT is_active, moderation_status, owner_user_id FROM ad_slots WHERE id = $1',
    [created.body.id]);
  assert.equal(row.rows[0].is_active, false, 'not showing on the public site');
  assert.equal(row.rows[0].moderation_status, 'pending_payment', 'and not yet in the approval queue');
  assert.equal(row.rows[0].owner_user_id, memberId, 'and it belongs to whoever submitted it');
});

test('the end date is start + duration, counting the first day', async () => {
  // A 7-day banner starting on the 1st runs to the 7th, not the 8th — an
  // off-by-one here is a day of advertising given away or withheld.
  const created = await req('POST', '/ad-banners', {
    token: memberToken, body: validBanner({ durationDays: 7, startsAt: '2026-03-01' }),
  });
  // Formatted in SQL on purpose. These are DATE columns, and reading one into
  // a JS Date puts it at LOCAL midnight — in SAST that is 22:00 UTC the
  // previous day, so .toISOString() would report the date one day early and
  // make a correct route look broken.
  const row = await pool.query(
    `SELECT to_char(starts_at, 'YYYY-MM-DD') AS starts,
            to_char(ends_at,   'YYYY-MM-DD') AS ends
       FROM ad_slots WHERE id = $1`, [created.body.id]);
  assert.equal(row.rows[0].starts, '2026-03-01');
  assert.equal(row.rows[0].ends, '2026-03-07',
    'a 7-day banner starting on the 1st ends on the 7th, not the 8th');
});

// ---------------------------------------------------------------------------
// Input the client does not get to decide
// ---------------------------------------------------------------------------

test('the placement must be one the server knows about', async () => {
  const bad = await req('POST', '/ad-banners', {
    token: memberToken, body: validBanner({ slotKey: 'somewhere-i-invented' }),
  });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /valid placement/i);
});

test('a banner needs an image', async () => {
  const bad = await req('POST', '/ad-banners', {
    token: memberToken, body: validBanner({ imageUrl: '   ' }),
  });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /banner image/i);
});

test('a link that is not http(s) is refused', async () => {
  // javascript: in an ad slot would be an XSS hole on every page it appears on.
  const bad = await req('POST', '/ad-banners', {
    token: memberToken, body: validBanner({ linkUrl: 'javascript:alert(1)' }),
  });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /http/i);
});

test('a banner with no link at all is fine', async () => {
  const ok = await req('POST', '/ad-banners', {
    token: memberToken, body: validBanner({ linkUrl: '' }),
  });
  assert.equal(ok.status, 201, 'not every sponsor has a website');
});

test('the placement list is fixed server-side', async () => {
  const opts = await req('GET', '/ad-banners/options');
  const keys = opts.body.placements.map((p) => p.key);
  assert.ok(keys.includes('home-sponsor-1'));
  assert.ok(opts.body.placements.every((p) => p.key && p.label),
    'every placement has a human label — the buy form shows the label, not the slug');
});

// ---------------------------------------------------------------------------
// Who can do what
// ---------------------------------------------------------------------------

test('buying requires signing in; the options are public', async () => {
  const anon = await req('POST', '/ad-banners', { body: validBanner() });
  assert.equal(anon.status, 401, 'a stranger cannot create a banner');

  const opts = await req('GET', '/ad-banners/options');
  assert.equal(opts.status, 200, 'but anyone can see what a banner costs before signing up');
});

test('/mine shows your banners and nobody else’s', async () => {
  const otherId = await makeUser();
  const otherToken = tokenFor(otherId);

  await req('POST', '/ad-banners', { token: otherToken, body: validBanner({ name: 'Other Business' }) });

  const mine = await req('GET', '/ad-banners/mine', { token: memberToken });
  assert.equal(mine.status, 200);
  assert.ok(mine.body.banners.length > 0, 'the member sees their own submissions');
  assert.ok(mine.body.banners.every((b) => b.name !== 'Other Business'),
    'and never another advertiser’s');

  const theirs = await req('GET', '/ad-banners/mine', { token: otherToken });
  assert.equal(theirs.body.banners.length, 1);
  assert.equal(theirs.body.banners[0].name, 'Other Business');
});

test('/mine requires signing in', async () => {
  const anon = await req('GET', '/ad-banners/mine');
  assert.equal(anon.status, 401);
});
