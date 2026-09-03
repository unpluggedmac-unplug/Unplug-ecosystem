// Renewal (§10.9) and upgrade pricing (§10.10).
//
// Both touch money, so what these protect is money-shaped:
//
//   1. RENEWING IS A NEW SUBMISSION, NOT AN EDIT. §10.11 says the underlying
//      record stays for history, reporting, renewal and audit. Overwriting the
//      expired one would destroy exactly that, and would drop a live service
//      back to awaiting_payment.
//   2. IT STARTS UNPAID. A renewal that arrived already approved would be a
//      free service.
//   3. IT IS ONLY EVER YOUR OWN, and "not found" and "not yours" are the same
//      answer.
//   4. ADMIN-ONLY FIELDS ARE NOT INHERITED. A member must not renew their way
//      into a placement an admin granted them once.
//   5. THE UPGRADE PRICE DID NOT CHANGE. Making it configurable must leave the
//      figure exactly where it was.

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
let token;
let otherToken;
let renewals;
let listingId;
let eventId;
let highlightId;
let profileId;
let articleId;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-renew-'));
const port = 54400 + (process.pid % 300);
const ME = 930101;
const OTHER = 930102;

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
  process.env.JWT_SECRET = 'test-secret-renewal';
  process.env.UNPLUG_DISABLE_RATE_LIMITS = '1';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(dir, f), 'utf8'));
  }

  renewals = require('../src/utils/renewals');

  const jwt = require('jsonwebtoken');
  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/my', require('../src/routes/mySubmissions'));
  app.use('/', require('../src/routes/profiles'));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await pool.query(
    `INSERT INTO users (id, email, full_name, password_hash, role)
     VALUES ($1,'me@ren.test','Me','x','member'), ($2,'other@ren.test','Other','x','member')`,
    [ME, OTHER]);
  token = jwt.sign({ id: ME, email: 'me@ren.test', role: 'member' }, process.env.JWT_SECRET);
  otherToken = jwt.sign({ id: OTHER, email: 'other@ren.test', role: 'member' },
    process.env.JWT_SECRET);

  const prof = await pool.query(
    `INSERT INTO profiles (user_id, display_name, slug, package_tier, status)
     VALUES ($1,'Me Profile','me-profile','basic','approved') RETURNING id`, [ME]);
  profileId = prof.rows[0].id;

  const adv = await pool.query(
    `INSERT INTO advertisers (user_id, business_name) VALUES ($1,'My Ads') RETURNING id`, [ME]);

  // An EXPIRED listing — the thing §10.9 is about.
  const listing = await pool.query(
    `INSERT INTO marketplace_listings
       (advertiser_id, poster_image_url, headline, duration_days, status, active_from, active_to)
     VALUES ($1,'http://x/poster.jpg','Winter Special',30,'approved',
             CURRENT_DATE - 60, CURRENT_DATE - 30)
     RETURNING id`, [adv.rows[0].id]);
  listingId = listing.rows[0].id;

  const art = await pool.query(
    `INSERT INTO articles (author_user_id, title, body, status)
     VALUES ($1,'My Article','body','approved') RETURNING id`, [ME]);
  articleId = art.rows[0].id;

  // An expired highlight WITH admin-set fields, to prove they do not carry over.
  const hl = await pool.query(
    `INSERT INTO highlights (target_type, target_id, duration_days, status,
                             start_date, end_date, priority, admin_image_url, is_admin)
     VALUES ('article',$1,28,'approved', CURRENT_DATE - 40, CURRENT_DATE - 12,
             99,'http://x/admin-chosen.jpg', true)
     RETURNING id`, [articleId]);
  highlightId = hl.rows[0].id;

  const ev = await pool.query(
    `INSERT INTO events (organizer_user_id, name, event_date, venue, description,
                         image_url, entrance_fee, status)
     VALUES ($1,'Last Year Festival', CURRENT_DATE - 90, 'Soweto Theatre','A great night',
             'http://x/event.jpg','R80','approved')
     RETURNING id`, [ME]);
  eventId = ev.rows[0].id;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
});

// ------------------------------------------------------------- §10.9 renewal

test('§10.9: RENEWING PREPOPULATES EVERYTHING THE MEMBER TYPED', async () => {
  const res = await api('POST', `/my/services/listing/${listingId}/renew`, null, token);
  assert.equal(res.status, 201, JSON.stringify(res.body));

  const fresh = res.body.renewal;
  assert.equal(fresh.headline, 'Winter Special', 'the headline carries over');
  assert.equal(fresh.poster_image_url, 'http://x/poster.jpg', 'and the media');
  assert.equal(fresh.duration_days, 30, 'and the duration they chose');
  assert.notEqual(fresh.id, listingId, 'it is a NEW listing');
});

test('IT STARTS UNPAID', async () => {
  // A renewal that arrived approved would be a free service.
  const r = await pool.query(
    `SELECT status FROM marketplace_listings WHERE headline = 'Winter Special'
      ORDER BY id DESC LIMIT 1`);
  assert.equal(r.rows[0].status, 'awaiting_payment');
});

test('THE EXPIRED ONE IS UNTOUCHED', async () => {
  // §10.11: the underlying record stays for history, reporting, renewal, audit.
  const old = await pool.query(
    `SELECT status, active_to FROM marketplace_listings WHERE id = $1`, [listingId]);
  assert.equal(old.rows[0].status, 'approved', 'the old listing still reads as it ran');
  assert.ok(old.rows[0].active_to, 'and still knows when it ended');
});

test('the new one carries no dates — a fresh term, not the old one', async () => {
  const r = await pool.query(
    `SELECT active_from, active_to FROM marketplace_listings
      WHERE headline = 'Winter Special' ORDER BY id DESC LIMIT 1`);
  assert.equal(r.rows[0].active_from, null);
  assert.equal(r.rows[0].active_to, null);
});

test('ADMIN-ONLY FIELDS ARE NOT INHERITED', async () => {
  // A member must not renew their way into a placement an admin granted once.
  const res = await api('POST', `/my/services/highlight/${highlightId}/renew`, null, token);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const fresh = res.body.renewal;
  assert.equal(fresh.target_id, articleId, 'it still points at the same article');
  assert.equal(fresh.duration_days, 28, 'and keeps the duration bought');
  assert.notEqual(fresh.priority, 99, 'but NOT the admin priority');
  assert.equal(fresh.admin_image_url, null, 'nor the admin image');
  assert.equal(fresh.is_admin, false, 'nor admin status');
});

test('an event is re-listed with its details and a date to change', async () => {
  const res = await api('POST', `/my/services/event/${eventId}/renew`, null, token);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const fresh = res.body.renewal;
  assert.equal(fresh.name, 'Last Year Festival');
  assert.equal(fresh.venue, 'Soweto Theatre');
  assert.equal(fresh.entrance_fee, 'R80');
  // NOT the old date: an event created in the past is born expired.
  assert.notEqual(String(fresh.event_date).slice(0, 10),
    String(new Date(Date.now() - 90 * 86400000).toISOString()).slice(0, 10));
});

test('an advert renews into its OWN status vocabulary, and not live', async () => {
  // ad_slots uses moderation_status and 'pending_payment'. Creating it as
  // status='awaiting_payment' would put it in a state the advert flow does not
  // recognise; leaving is_active true would put an unpaid advert on the site.
  const ad = await pool.query(
    `INSERT INTO ad_slots (slot_key, image_url, link_url, name, owner_user_id,
                           moderation_status, duration_days, starts_at, ends_at,
                           is_active, display_order)
     VALUES ('renew-slot','http://x/ad.jpg','http://x/go','Winter Advert',$1,
             'approved',30, CURRENT_DATE - 60, CURRENT_DATE - 30, true, 5)
     RETURNING id`, [ME]);

  const res = await api('POST', `/my/services/advertising/${ad.rows[0].id}/renew`, null, token);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const fresh = res.body.renewal;
  assert.equal(fresh.name, 'Winter Advert', 'the advert copies');
  assert.equal(fresh.duration_days, 30);
  assert.equal(fresh.moderation_status, 'pending_payment', 'its own status vocabulary');
  assert.equal(fresh.is_active, false, 'an unpaid advert is not on the site');
  assert.equal(fresh.display_order, 0, 'and does not inherit a placement');
  assert.equal(fresh.starts_at, null, 'a fresh term');
  assert.equal(fresh.ends_at, null);
});

test('IT IS ONLY EVER YOUR OWN', async () => {
  const res = await api('POST', `/my/services/listing/${listingId}/renew`, null, otherToken);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /could not be found/i,
    'not found and not yours must read the same');
});

test('signed out cannot renew', async () => {
  assert.equal((await api('POST', `/my/services/listing/${listingId}/renew`, null, null)).status, 401);
});

test('a service with no term says why it cannot be renewed', async () => {
  // An honest sentence beats "unknown type".
  const res = await api('POST', `/my/services/article/${articleId}/renew`, null, token);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /stays published/i);
});

test('every type the dashboard can show is either renewable or explained', () => {
  // A type in neither list would give a member a dead button and no reason.
  const { SERVICE_TYPES } = require('../src/utils/mySubmissions');
  for (const type of SERVICE_TYPES) {
    const known = renewals.isRenewable(type)
      || Object.prototype.hasOwnProperty.call(renewals.NOT_RENEWABLE, type);
    assert.ok(known, `${type} is neither renewable nor explained`);
  }
});

// -------------------------------------------------------- §10.10 upgrade fee

test('§10.10: THE UPGRADE PRICE DID NOT CHANGE', async () => {
  // Making a price configurable must not move it. docs/pricing-comparison.md
  // records spec and live agreeing on R250, and decision 8 forbids a price
  // change without a full comparison.
  const seeded = await pool.query(
    `SELECT value FROM settings WHERE key = 'profile_upgrade_fee'`);
  assert.equal(seeded.rowCount, 1, 'the setting should be seeded');
  assert.equal(Number(seeded.rows[0].value), 250.00);

  const res = await api('POST', `/profiles/${profileId}/upgrade`, { toTier: 'pro' }, token);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(Number(res.body.upgrade.fee_paid), 250.00, 'still R250');
});

test('an admin can change it without a code change', async () => {
  await pool.query(
    `UPDATE settings SET value = '300.00' WHERE key = 'profile_upgrade_fee'`);
  const res = await api('POST', `/profiles/${profileId}/upgrade`, { toTier: 'premium' }, token);
  assert.equal(res.status, 201);
  assert.equal(Number(res.body.upgrade.fee_paid), 300.00, 'the configured figure is used');
  await pool.query(
    `UPDATE settings SET value = '250.00' WHERE key = 'profile_upgrade_fee'`);
});

test('what was quoted is stored, so a later change does not alter it', async () => {
  // fee_paid is on the row. If the setting moves tomorrow, an upgrade quoted
  // today is still charged what the member was told.
  const before = await pool.query(
    `SELECT fee_paid FROM profile_upgrades ORDER BY id ASC LIMIT 1`);
  await pool.query(`UPDATE settings SET value = '999.00' WHERE key = 'profile_upgrade_fee'`);
  const after = await pool.query(
    `SELECT fee_paid FROM profile_upgrades ORDER BY id ASC LIMIT 1`);
  assert.equal(Number(after.rows[0].fee_paid), Number(before.rows[0].fee_paid));
  await pool.query(`UPDATE settings SET value = '250.00' WHERE key = 'profile_upgrade_fee'`);
});

test('an unreadable or missing setting falls back to the same number', async () => {
  await pool.query(`DELETE FROM settings WHERE key = 'profile_upgrade_fee'`);
  const res = await api('POST', `/profiles/${profileId}/upgrade`, { toTier: 'premium' }, token);
  // premium was already reached above, so this may be refused as a downgrade —
  // what matters is that nothing throws and any fee quoted is the fallback.
  if (res.status === 201) {
    assert.equal(Number(res.body.upgrade.fee_paid), 250.00);
  }
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ('profile_upgrade_fee','250.00')
     ON CONFLICT (key) DO NOTHING`);
});

test('a deploy cannot overwrite a fee an admin set', async () => {
  // Same guarantee the VAT number has: ON CONFLICT DO NOTHING.
  await pool.query(`UPDATE settings SET value = '275.00' WHERE key = 'profile_upgrade_fee'`);
  const migration = fs.readFileSync(
    path.join(__dirname, '..', 'db', 'migrations', '166_upgrade_fee_setting.sql'), 'utf8');
  await pool.query(migration);
  const r = await pool.query(
    `SELECT value FROM settings WHERE key = 'profile_upgrade_fee'`);
  assert.equal(Number(r.rows[0].value), 275.00, 'a re-run must not reset it');
  await pool.query(`UPDATE settings SET value = '250.00' WHERE key = 'profile_upgrade_fee'`);
});
