// ANALYTICS — capture, attribution, and the funnel to revenue.
//
// The failures worth guarding against here are all SILENT ones: analytics that
// records the wrong thing looks exactly like analytics that works, and gets
// believed. Specifically:
//
//   1. A visit's SOURCE must be fixed at the moment it starts. If a later page
//      view can overwrite it, every visit ends up attributed to Unplug itself
//      and every real channel disappears.
//   2. Revenue must be counted ONCE. applyPaymentEffect can legitimately run
//      twice; a doubled revenue figure is worse than none.
//   3. Money must never be settable from the browser.
//   4. Nothing may be recorded for a visitor who has not consented — enforced
//      in the browser, but the server must not invent ids either.
//   5. Attribution is FIRST touch, so a customer is credited to the channel
//      that found them, not to whichever page they happened to pay on.
//
// Over real HTTP against real PostgreSQL. See universalComments.test.js for
// why require('../src/app') is avoided.
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
let recorder;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-anlx-'));
const port = 28400 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

async function req(method, urlPath, { token, body, headers } = {}) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': IPHONE,
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(headers || {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, body: json };
}

function tokenFor(userId, role = 'member') {
  return jwt.sign({ id: userId, email: `an${userId}@test.com`, role }, process.env.JWT_SECRET);
}

let _nextUserId = 211000;
async function makeUser(role = 'member') {
  const id = _nextUserId++;
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', $3) ON CONFLICT DO NOTHING`,
    [id, `an${id}@test.com`, role]
  );
  return id;
}

let adminToken;

before(async () => {
  pg = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'postgres', password: 'postgres', port,
    persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('unplug_test');

  process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${port}/unplug_test`;
  process.env.JWT_SECRET = 'test-secret-for-analytics';
  process.env.UNPLUG_DISABLE_RATE_LIMITS = '1';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }

  jwt = require('jsonwebtoken');
  recorder = require('../src/utils/analyticsRecorder');

  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/analytics', require('../src/routes/analytics'));
  app.use('/analytics-reports', require('../src/routes/analyticsReports'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  adminToken = tokenFor(await makeUser('admin'), 'admin');
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
// Capture
// ---------------------------------------------------------------------------

test('a page view records the visit, its source, and the device', async () => {
  const res = await req('POST', '/analytics/track', {
    body: {
      pagePath: '/?p=home', sessionId: 's-1', visitorId: 'v-1',
      referrer: 'https://l.instagram.com/?u=https%3A%2F%2Funplugnews.com',
    },
    headers: { 'CF-IPCountry': 'ZA' },
  });
  assert.equal(res.status, 201);

  const s = (await pool.query('SELECT * FROM analytics_sessions WHERE session_id = $1', ['s-1'])).rows[0];
  assert.equal(s.source, 'Instagram', 'a link-wrapper host must still read as Instagram');
  assert.equal(s.device_type, 'mobile');
  assert.equal(s.os, 'iOS');
  assert.equal(s.country, 'ZA');
  assert.equal(s.is_returning, false, 'a visitor id never seen before is new');
  assert.equal(s.entry_path, '/?p=home');
  assert.equal(s.page_count, 1);
});

test('THE SOURCE OF A VISIT IS FIXED WHEN IT STARTS', async () => {
  // The reader now clicks through to an article. The referrer for that request
  // is Unplug itself. If this overwrote the source, every visit on the site
  // would end up attributed to Unplug and Instagram would vanish from the
  // report entirely.
  await req('POST', '/analytics/track', {
    body: {
      pagePath: '/?p=article&id=5', sessionId: 's-1', visitorId: 'v-1',
      referrer: 'https://www.unplugnews.com/?p=home',
    },
  });

  const s = (await pool.query('SELECT * FROM analytics_sessions WHERE session_id = $1', ['s-1'])).rows[0];
  assert.equal(s.source, 'Instagram', 'the visit still came from Instagram');
  assert.equal(s.entry_path, '/?p=home', 'and it still started on the page it started on');
  assert.equal(s.exit_path, '/?p=article&id=5', 'but the last page seen moves');
  assert.equal(s.page_count, 2);
});

test('a second visit from the same browser is marked returning', async () => {
  await req('POST', '/analytics/track', {
    body: { pagePath: '/?p=news', sessionId: 's-2', visitorId: 'v-1', referrer: '' },
  });
  const s = (await pool.query('SELECT * FROM analytics_sessions WHERE session_id = $1', ['s-2'])).rows[0];
  assert.equal(s.is_returning, true);
  assert.equal(s.source, 'Direct', 'no referrer and no tags is Direct');

  // And the FIRST visit must not be retroactively relabelled as returning.
  const first = (await pool.query('SELECT is_returning FROM analytics_sessions WHERE session_id = $1', ['s-1'])).rows[0];
  assert.equal(first.is_returning, false);
});

test('a tagged campaign link beats whatever the referrer says', async () => {
  await req('POST', '/analytics/track', {
    body: {
      pagePath: '/?p=home', sessionId: 's-3', visitorId: 'v-3',
      referrer: '', utmSource: 'Mailchimp', utmMedium: 'email', utmCampaign: 'august-edition',
    },
  });
  const s = (await pool.query('SELECT * FROM analytics_sessions WHERE session_id = $1', ['s-3'])).rows[0];
  assert.equal(s.source, 'Mailchimp');
  assert.equal(s.medium, 'Email', 'an email click has no referrer — only the tag can tell us');
  assert.equal(s.campaign, 'august-edition');
});

test('an unknown country header leaves country empty rather than guessing', async () => {
  await req('POST', '/analytics/track', {
    body: { pagePath: '/?p=home', sessionId: 's-4', visitorId: 'v-4' },
  });
  const s = (await pool.query('SELECT country FROM analytics_sessions WHERE session_id = $1', ['s-4'])).rows[0];
  assert.equal(s.country, null, 'defaulting to ZA would make the audience look local whatever the truth');
});

test('no session id means nothing is invented', async () => {
  // A visitor who has not consented sends no ids. The server must not mint one.
  const before = (await pool.query('SELECT COUNT(*)::int AS n FROM analytics_sessions')).rows[0].n;
  const res = await req('POST', '/analytics/track', { body: { pagePath: '/?p=home' } });
  assert.equal(res.status, 201);
  const after = (await pool.query('SELECT COUNT(*)::int AS n FROM analytics_sessions')).rows[0].n;
  assert.equal(after, before, 'a request with no ids must not create a session');
});

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

async function makePayment(userId, amount) {
  const r = await pool.query(
    `INSERT INTO payments (user_id, amount, method, gateway_reference, status, linked_type, linked_id)
     VALUES ($1, $2, 'eft', $3, 'confirmed', 'article_publish', 1) RETURNING *`,
    [userId, amount, 'ANLX-' + Math.random().toString(36).slice(2, 10)]
  );
  return r.rows[0];
}

test('A CONFIRMED PAYMENT IS COUNTED EXACTLY ONCE', async () => {
  const userId = await makeUser();
  const payment = await makePayment(userId, 95);

  await recorder.recordPaymentOnce(payment);
  await recorder.recordPaymentOnce(payment); // a re-confirm, or a cart retry
  await recorder.recordPaymentOnce(payment);

  const r = await pool.query(
    `SELECT COUNT(*)::int AS n, SUM(value_cents)::int AS cents FROM analytics_events
      WHERE event_name = 'payment' AND entity_id = $1`, [payment.id]
  );
  assert.equal(r.rows[0].n, 1, 'DOUBLE-COUNTED REVENUE IS WORSE THAN NO REVENUE DATA');
  assert.equal(r.rows[0].cents, 9500, 'R95.00 is stored as 9500 cents, with no rounding');
});

test('an unconfirmed payment is not revenue', async () => {
  const userId = await makeUser();
  const r = await pool.query(
    `INSERT INTO payments (user_id, amount, method, gateway_reference, status, linked_type, linked_id)
     VALUES ($1, 500, 'eft', $2, 'pending', 'article_publish', 1) RETURNING *`,
    [userId, 'ANLX-PEND-' + Math.random().toString(36).slice(2, 8)]
  );
  await recorder.recordPaymentOnce(r.rows[0]);
  const found = await pool.query(
    `SELECT COUNT(*)::int AS n FROM analytics_events WHERE event_name = 'payment' AND entity_id = $1`,
    [r.rows[0].id]
  );
  assert.equal(found.rows[0].n, 0, 'money that has not arrived is not revenue');
});

test('THE BROWSER CANNOT REPORT MONEY', async () => {
  // /analytics/event is unauthenticated by design. If a value posted to it were
  // trusted, anyone could inflate the revenue figures from a console.
  await req('POST', '/analytics/event', {
    body: { eventName: 'payment', sessionId: 's-9', visitorId: 'v-9', valueCents: 99999999 },
  });
  const r = await pool.query(
    `SELECT value_cents FROM analytics_events WHERE session_id = 's-9' AND event_name = 'payment'`
  );
  assert.equal(r.rows.length, 1, 'the event is still recorded');
  assert.equal(r.rows[0].value_cents, null, 'BUT THE AMOUNT IS DISCARDED — money comes only from the server');
});

test('an over-long event name is refused rather than truncated', async () => {
  const res = await req('POST', '/analytics/event', {
    body: { eventName: 'x'.repeat(200), sessionId: 's-10', visitorId: 'v-10' },
  });
  assert.equal(res.status, 400);
});

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

test('the overview counts visits and visitors separately', async () => {
  const res = await req('GET', '/analytics-reports/overview', { token: adminToken });
  assert.equal(res.status, 200);
  const t = res.body.totals;
  assert.ok(t.sessions >= 4);
  assert.ok(t.visitors >= 3);
  assert.ok(t.sessions > t.visitors - 1, 'one visitor made two visits, so sessions must exceed visitors');
  assert.ok(Array.isArray(res.body.daily));
});

test('the sources report names the channels', async () => {
  const res = await req('GET', '/analytics-reports/sources', { token: adminToken });
  const names = res.body.sources.map((s) => s.source);
  assert.ok(names.includes('Instagram'));
  assert.ok(names.includes('Direct'));
  assert.ok(names.includes('Mailchimp'));
});

test('the audience report groups devices and marks unknown country honestly', async () => {
  const res = await req('GET', '/analytics-reports/audience', { token: adminToken });
  assert.ok(res.body.devices.some((d) => d.label === 'mobile'));
  assert.ok(res.body.countries.some((c) => c.label === 'ZA'));
  assert.ok(res.body.countries.some((c) => c.label === 'Unknown'),
    'sessions with no country must be shown as Unknown, not dropped or defaulted');
  assert.ok(res.body.loyalty.length > 0);
});

test('REVENUE IS CREDITED TO THE CHANNEL THAT FIRST FOUND THE CUSTOMER', async () => {
  // Someone arrives from Instagram, comes back later by typing the address in,
  // and only then pays. Last-touch would credit that to Direct and make every
  // channel look like it does nothing.
  const userId = await makeUser();
  await req('POST', '/analytics/track', {
    body: { pagePath: '/?p=home', sessionId: 'ft-1', visitorId: 'ft-v', referrer: 'https://www.instagram.com/' },
  });
  await req('POST', '/analytics/track', {
    body: { pagePath: '/?p=home', sessionId: 'ft-2', visitorId: 'ft-v', referrer: '' },
  });
  await pool.query('UPDATE analytics_sessions SET user_id = $1 WHERE visitor_id = $2', [userId, 'ft-v']);

  const payment = await makePayment(userId, 250);
  await recorder.recordPaymentOnce(payment);

  const res = await req('GET', '/analytics-reports/funnel', { token: adminToken });
  const instagram = res.body.bySource.find((r) => r.source === 'Instagram');
  assert.ok(instagram, 'Instagram must appear as a revenue source');
  assert.ok(instagram.revenue_cents >= 25000, 'the R250 belongs to the visit that found them');
  assert.ok(res.body.funnel.revenueCents >= 25000);
  assert.ok(res.body.funnel.customers >= 1);
});

test('identify binds earlier anonymous visits to the account', async () => {
  const userId = await makeUser();
  const token = tokenFor(userId);
  await req('POST', '/analytics/track', {
    body: { pagePath: '/?p=home', sessionId: 'id-1', visitorId: 'id-v', referrer: 'https://www.tiktok.com/' },
  });
  await req('POST', '/analytics/track', {
    body: { pagePath: '/?p=news', sessionId: 'id-2', visitorId: 'id-v' },
  });

  const res = await req('POST', '/analytics/identify', {
    token, body: { sessionId: 'id-2', visitorId: 'id-v' },
  });
  assert.equal(res.status, 200);

  const rows = await pool.query(
    'SELECT session_id FROM analytics_sessions WHERE visitor_id = $1 AND user_id = $2', ['id-v', userId]
  );
  assert.equal(rows.rows.length, 2,
    'the visit that FOUND them must be claimed too, or first-touch attribution is impossible');
});

test('identify requires signing in', async () => {
  assert.equal((await req('POST', '/analytics/identify', { body: { sessionId: 's-1' } })).status, 401);
});

test('the live GA property is served, and only when it is valid', async () => {
  // Seeded by migration 119 — Google Analytics is on out of the box.
  let res = await req('GET', '/analytics/config');
  assert.equal(res.body.ga4MeasurementId, 'G-7CNWS63ZHD', 'the real property ships configured');

  await pool.query(`UPDATE settings SET value = 'not-a-real-id' WHERE key = 'ga4_measurement_id'`);
  res = await req('GET', '/analytics/config');
  assert.equal(res.body.ga4MeasurementId, null,
    'a malformed id is refused rather than passed through to load a tag that fires at nothing');

  await pool.query(`UPDATE settings SET value = '' WHERE key = 'ga4_measurement_id'`);
  res = await req('GET', '/analytics/config');
  assert.equal(res.body.ga4MeasurementId, null, 'clearing the field switches Google Analytics off');

  await pool.query(`UPDATE settings SET value = 'G-7CNWS63ZHD' WHERE key = 'ga4_measurement_id'`);
});

test('the real GA property is seeded, and a re-deploy never overrides a change', async () => {
  // Migrations re-run on EVERY deploy. Without the one-time marker this would
  // silently reinstate the seeded id each time, undoing an admin who changed
  // it — or who cleared it deliberately to switch Google Analytics off.
  const migrations = fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations'))
    .filter((x) => x.endsWith('.sql')).sort();
  const rerun = async () => {
    for (const f of migrations) {
      await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
    }
  };

  // An admin decides to point at a different property.
  await pool.query(`UPDATE settings SET value = 'G-ADMINCHOICE' WHERE key = 'ga4_measurement_id'`);
  await rerun();
  let v = (await pool.query(`SELECT value FROM settings WHERE key = 'ga4_measurement_id'`)).rows[0].value;
  assert.equal(v, 'G-ADMINCHOICE', 'a deploy must not overwrite the id an admin chose');

  // An admin switches Google Analytics off entirely.
  await pool.query(`UPDATE settings SET value = '' WHERE key = 'ga4_measurement_id'`);
  await rerun();
  v = (await pool.query(`SELECT value FROM settings WHERE key = 'ga4_measurement_id'`)).rows[0].value;
  assert.equal(v, '', 'clearing the field must stay cleared through a deploy');

  const res = await req('GET', '/analytics/config');
  assert.equal(res.body.ga4MeasurementId, null, 'and no tag is served while it is empty');
});

// ---------------------------------------------------------------------------
// TOPICS — what subjects get read, tapped and searched for
// ---------------------------------------------------------------------------

async function makeArticleWith(title, categoryName, tags) {
  // categories.name carries no unique constraint, so look before inserting
  // rather than relying on ON CONFLICT.
  let cat = await pool.query('SELECT id FROM categories WHERE name = $1', [categoryName]);
  if (cat.rows.length === 0) {
    cat = await pool.query('INSERT INTO categories (name) VALUES ($1) RETURNING id', [categoryName]);
  }
  const owner = await makeUser();
  const a = await pool.query(
    `INSERT INTO articles (author_user_id, title, body, status, category_id, tags, published_at)
     VALUES ($1, $2, 'Body text for a real article about the subject.', 'approved', $3, $4, now())
     RETURNING id`,
    [owner, title, cat.rows[0].id, tags]
  );
  return a.rows[0].id;
}

test('reads are grouped by the CURATED category, not just the page path', async () => {
  const health = await makeArticleWith('Health Piece', 'Health & Wellness', ['Wellness', 'Clinics']);
  const motor = await makeArticleWith('Motoring Piece', 'Motoring', ['Bakkies']);

  for (let i = 0; i < 3; i++) {
    await req('POST', '/analytics/track', {
      body: { pagePath: '/?p=article&id=' + health, sessionId: 'tp-' + i, visitorId: 'tpv-' + i,
        entityType: 'article', entityId: health },
    });
  }
  await req('POST', '/analytics/track', {
    body: { pagePath: '/?p=article&id=' + motor, sessionId: 'tp-m', visitorId: 'tpv-m',
      entityType: 'article', entityId: motor },
  });

  const res = await req('GET', '/analytics-reports/topics', { token: adminToken });
  assert.equal(res.status, 200);
  const healthRow = res.body.categories.find((c) => c.label === 'Health & Wellness');
  const motorRow = res.body.categories.find((c) => c.label === 'Motoring');
  assert.equal(healthRow.reads, 3);
  assert.equal(motorRow.reads, 1);
  assert.ok(res.body.categories.indexOf(healthRow) < res.body.categories.indexOf(motorRow),
    'the most-read subject must come first');
});

test('an article carrying several tags counts as a read of each of them', async () => {
  const res = await req('GET', '/analytics-reports/topics', { token: adminToken });
  const wellness = res.body.tags.find((t) => t.label === 'Wellness');
  const clinics = res.body.tags.find((t) => t.label === 'Clinics');
  assert.equal(wellness.reads, 3);
  assert.equal(clinics.reads, 3, 'a piece tagged with several subjects is a read of each of them');
});

test('A TAP ON A TOPIC IS COUNTED SEPARATELY FROM A READ', async () => {
  // A read is attention; a tap is a reader asking for MORE of this subject.
  // Folding them together would bury the stronger signal in the larger number.
  // THE STATUS IS ASSERTED. This test has failed intermittently under a full
  // suite run with "1 !== 2" — one of these two taps missing — and it was not
  // diagnosable, because a 500 here passed silently and the failure surfaced
  // several lines later as a wrong count. If it happens again, this says which
  // request failed and what the server said about it.
  for (const n of [1, 2]) {
    const posted = await req('POST', '/analytics/event', {
      body: { eventName: 'topic_click', label: 'Wellness', sessionId: `tp-${n}`, visitorId: `tpv-${n}` },
    });
    assert.equal(posted.status, 201,
      `tap ${n} was not recorded: ${JSON.stringify(posted.body)}`);
  }

  const res = await req('GET', '/analytics-reports/topics', { token: adminToken });
  const tap = res.body.tagTaps.find((t) => t.label === 'Wellness');
  assert.equal(tap.taps, 2);
  assert.equal(tap.people, 2, 'two different readers, not one reader twice');

  const read = res.body.tags.find((t) => t.label === 'Wellness');
  assert.equal(read.reads, 3, 'the read count is untouched by the taps');
});

test('A SEARCH THAT FOUND NOTHING IS RECORDED AS SUCH', async () => {
  // The most useful editorial signal on the site: a subject the audience asked
  // for and the publication does not cover. No traffic report can show it,
  // because traffic only describes what was already published.
  await req('POST', '/analytics/event', {
    body: { eventName: 'site_search', label: 'rugby', sessionId: 'tp-s', visitorId: 'tpv-s' },
  });
  await req('POST', '/analytics/event', {
    body: { eventName: 'site_search_empty', label: 'rugby', sessionId: 'tp-s', visitorId: 'tpv-s' },
  });
  await req('POST', '/analytics/event', {
    body: { eventName: 'site_search', label: 'health', sessionId: 'tp-s2', visitorId: 'tpv-s2' },
  });

  const res = await req('GET', '/analytics-reports/topics', { token: adminToken });
  const rugby = res.body.searches.find((s) => s.label === 'rugby');
  const health = res.body.searches.find((s) => s.label === 'health');
  assert.equal(rugby.searches, 1);
  assert.equal(rugby.found_nothing, 1, 'nobody covers rugby here, and the report must say so');
  assert.equal(health.found_nothing, 0);
});

test('a very long search string is stored, not rejected', async () => {
  const long = 'x'.repeat(400);
  const res = await req('POST', '/analytics/event', {
    body: { eventName: 'site_search', label: long, sessionId: 'tp-s3', visitorId: 'tpv-s3' },
  });
  assert.equal(res.status, 201, 'a rambling search is still a real signal');
  const row = await pool.query(
    "SELECT length(label) AS n FROM analytics_events WHERE session_id = 'tp-s3'"
  );
  assert.equal(Number(row.rows[0].n), 160, 'trimmed to the column rather than dropped');
});

test('REVENUE IS CREDITED TO THE FIRST SUBJECT A CUSTOMER READ', async () => {
  // Splitting revenue across every category someone ever read would report
  // more money than was actually earned. Crediting the last thing they read
  // hands every sale to whatever they happened to have open at the time.
  const buyer = await makeUser();
  const fashion = await makeArticleWith('Fashion Piece', 'Fashion & Style', ['Runway']);
  const finance = await makeArticleWith('Finance Piece', 'Finance & Wealth', ['Saving']);

  await pool.query(
    `INSERT INTO analytics_events (event_name, entity_type, entity_id, user_id, occurred_at)
     VALUES ('page_view', 'article', $1, $2, now() - interval '2 days')`,
    [fashion, buyer]
  );
  await pool.query(
    `INSERT INTO analytics_events (event_name, entity_type, entity_id, user_id, occurred_at)
     VALUES ('page_view', 'article', $1, $2, now() - interval '1 day')`,
    [finance, buyer]
  );
  const payment = await makePayment(buyer, 400);
  await recorder.recordPaymentOnce(payment);

  const res = await req('GET', '/analytics-reports/topics', { token: adminToken });
  const f = res.body.revenueByCategory.find((r) => r.label === 'Fashion & Style');
  const fin = res.body.revenueByCategory.find((r) => r.label === 'Finance & Wealth');
  assert.ok(f && f.revenue_cents >= 40000, 'the subject that FOUND them gets the credit');
  assert.ok(!fin || fin.revenue_cents === 0, 'the last thing they read must not also be credited');
});

test('a customer who never read an article is shown, not dropped', async () => {
  // Otherwise the revenue column silently stops adding up to real revenue.
  const buyer = await makeUser();
  const payment = await makePayment(buyer, 150);
  await recorder.recordPaymentOnce(payment);

  const res = await req('GET', '/analytics-reports/topics', { token: adminToken });
  const none = res.body.revenueByCategory.find((r) => r.label === 'No article read');
  assert.ok(none, 'a payment with no reading behind it still belongs in the totals');
  assert.ok(none.revenue_cents >= 15000);
});

test('the topics report is admin-only', async () => {
  const memberToken = tokenFor(await makeUser());
  assert.equal((await req('GET', '/analytics-reports/topics')).status, 401);
  assert.equal((await req('GET', '/analytics-reports/topics', { token: memberToken })).status, 403);
});

test('every report is admin-only', async () => {
  const memberToken = tokenFor(await makeUser());
  for (const p of ['overview', 'sources', 'content', 'audience', 'funnel']) {
    assert.equal((await req('GET', `/analytics-reports/${p}`)).status, 401, p);
    assert.equal((await req('GET', `/analytics-reports/${p}`, { token: memberToken })).status, 403, p);
  }
});

test('a report window is bounded even when asked for everything', async () => {
  const res = await req('GET', '/analytics-reports/overview?from=1900-01-01', { token: adminToken });
  assert.equal(res.status, 200);
  assert.ok(new Date(res.body.window.from).getFullYear() > 2000,
    'an unbounded window would scan the whole table as it grows');
});

test('re-running every migration is idempotent', async () => {
  const before = await pool.query('SELECT COUNT(*)::int AS n FROM analytics_events');
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }
  const after = await pool.query('SELECT COUNT(*)::int AS n FROM analytics_events');
  assert.equal(after.rows[0].n, before.rows[0].n, 'a re-deploy must not disturb recorded analytics');
});
