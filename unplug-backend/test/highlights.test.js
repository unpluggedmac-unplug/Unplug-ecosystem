// Highlights — paid promotion and editorial boosts — against a REAL PostgreSQL.
//
// Two different systems share this table and this router, which is the main
// thing worth pinning down:
//
//   * an ADMIN highlight is editorial. It is created already approved, with no
//     payment, and it can point at anything.
//   * a MEMBER highlight is a purchase. It starts unpaid and unapproved, it can
//     only point at the member's own article or profile, and the end date is
//     derived from the duration that was paid for.
//
// The specific failures these guard against:
//
//   1. the buy form quoting a price the checkout does not charge — the packages
//      endpoint used to serve a hardcoded table while payments charged from the
//      admin-managed service_packages, so an admin price change moved one and
//      not the other;
//   2. /active showing something before its start date, after its end date, or
//      before it was approved — that is unpaid advertising on a live site;
//   3. a member highlighting somebody else's article.
//
// Run with:  npm test   (from unplug-backend/)

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const EmbeddedPostgres = require('embedded-postgres').default;

let pg;
let pool;
let server;
let baseUrl;
let jwt;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-highlights-'));
const port = 31600 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

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
  return jwt.sign({ id: userId, email: `hl${userId}@test.com`, role }, process.env.JWT_SECRET);
}

let _nextUserId = 441000;
let _slug = 0;

async function makeUser(role = 'member') {
  const id = _nextUserId++;
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', $3) ON CONFLICT DO NOTHING`,
    [id, `hl${id}@test.com`, role]
  );
  return id;
}

async function makeArticle(userId, title = 'A Story') {
  const r = await pool.query(
    `INSERT INTO articles (title, body, author_user_id, status)
     VALUES ($1, 'body', $2, 'approved') RETURNING id`, [title, userId]);
  return r.rows[0].id;
}

async function makeProfile(userId, name = 'A Business') {
  const r = await pool.query(
    `INSERT INTO profiles (user_id, type, package_tier, slug, display_name, status)
     VALUES ($1, 'business', 'basic', $2, $3, 'approved') RETURNING id`,
    [userId, `hl-profile-${_slug++}`, name]);
  return r.rows[0].id;
}

// Dates relative to today, so these tests do not expire — and counted from
// the DATABASE's today, not Node's.
//
// The route compares ends_at against CURRENT_DATE, the Postgres server's local
// date. Deriving these from UTC meant that between local midnight and UTC
// midnight — two hours every night in South Africa — dayOffset(0) was actually
// yesterday, and "shown on its last day" failed for reasons unrelated to the
// code. Both sides now read the same clock.
let serverToday = null; // filled in before(), from SELECT CURRENT_DATE

function dayOffset(n) {
  if (!serverToday) throw new Error('serverToday is read in before() — call dayOffset inside a test');
  const d = new Date(serverToday + 'T00:00:00Z');
  return new Date(d.getTime() + n * 86400000).toISOString().slice(0, 10);
}

let adminId;
let adminToken;
let memberId;
let memberToken;

before(async () => {
  pg = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'postgres', password: 'postgres', port,
    persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('unplug_test');

  process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${port}/unplug_test`;
  process.env.JWT_SECRET = 'test-secret-for-highlights';
  process.env.UNPLUG_DISABLE_RATE_LIMITS = '1';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }

  serverToday = (await pool.query("SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS d")).rows[0].d;

  jwt = require('jsonwebtoken');

  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/highlights', require('../src/routes/highlights'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  adminId = await makeUser('admin');
  adminToken = tokenFor(adminId, 'admin');
  memberId = await makeUser();
  memberToken = tokenFor(memberId);
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  // Windows can still hold a handle on the data directory when Postgres
  // exits, and embedded-postgres removes that directory as part of
  // stopping. The server is already down by then, so an EBUSY here is
  // the OS being slow to let go, not a failure worth failing the file
  // for — and a teardown that goes red teaches everyone to ignore red.
  try { if (pg) await pg.stop(); } catch (e) { /* see above */ }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* Windows holds the dir briefly */ }
});

// ---------------------------------------------------------------------------
// The price on the buy form is the price that gets charged
// ---------------------------------------------------------------------------

test('THE BUY FORM QUOTES THE ADMIN-MANAGED PRICE, NOT A HARDCODED COPY', async () => {
  // This is the regression that mattered: the packages endpoint used to serve
  // its own constants, so an admin price change was charged at checkout but
  // never shown on the form. Change the price and the form must follow.
  const before = await req('GET', '/highlights/packages');
  assert.equal(before.status, 200);
  const quoted = before.body.packages.article.find((p) => p.durationDays === 7);
  assert.ok(quoted, 'a 7-day article highlight is on sale');

  await pool.query(
    `UPDATE service_packages SET price = price + 77
      WHERE service_key = 'highlight_article' AND duration_days = 7`);

  const after = await req('GET', '/highlights/packages');
  const requoted = after.body.packages.article.find((p) => p.durationDays === 7);
  assert.equal(requoted.price, quoted.price + 77,
    'the form must show the price the admin actually set');

  await pool.query(
    `UPDATE service_packages SET price = price - 77
      WHERE service_key = 'highlight_article' AND duration_days = 7`);
});

test('the form quotes the same number the payment code resolves', async () => {
  // Both sides go through service_packages; this proves they agree rather
  // than assuming it from reading two files.
  const { priceFor, highlightServiceKey } = require('../src/utils/servicePackages');
  const form = await req('GET', '/highlights/packages');

  for (const targetType of ['article', 'directory']) {
    for (const pkg of form.body.packages[targetType]) {
      const charged = await priceFor(highlightServiceKey(targetType), pkg.durationDays);
      assert.equal(charged, pkg.price,
        `${targetType} ${pkg.durationDays}-day: form says ${pkg.price}, checkout charges ${charged}`);
    }
  }
});

test('a package the admin switched off drops off the buy form', async () => {
  await pool.query(
    `UPDATE service_packages SET active = false
      WHERE service_key = 'highlight_directory' AND duration_days = 21`);

  const list = await req('GET', '/highlights/packages');
  assert.ok(!list.body.packages.directory.some((p) => p.durationDays === 21),
    'a package that is not for sale is not offered');

  await pool.query(
    `UPDATE service_packages SET active = true
      WHERE service_key = 'highlight_directory' AND duration_days = 21`);
});

test('prices are public — you can see what a highlight costs before signing up', async () => {
  const anon = await req('GET', '/highlights/packages');
  assert.equal(anon.status, 200);
  assert.ok(anon.body.packages.article.length > 0);
});

// ---------------------------------------------------------------------------
// /active is what the public site renders — nothing may leak into it
// ---------------------------------------------------------------------------

test('NOTHING UNAPPROVED APPEARS ON THE PUBLIC SITE', async () => {
  const articleId = await makeArticle(memberId, 'Not Paid For');
  await pool.query(
    `INSERT INTO highlights (target_type, target_id, status, start_date, end_date)
     VALUES ('article', $1, 'awaiting_payment', $2, $3)`,
    [articleId, dayOffset(-1), dayOffset(30)]);

  const active = await req('GET', '/highlights/active');
  assert.ok(!active.body.highlights.some((h) => h.target_id === articleId),
    'an unpaid highlight must never render as though it were bought');
});

test('a highlight that has not started yet is not shown', async () => {
  const articleId = await makeArticle(memberId, 'Starts Next Week');
  await pool.query(
    `INSERT INTO highlights (target_type, target_id, status, start_date, end_date)
     VALUES ('article', $1, 'approved', $2, $3)`,
    [articleId, dayOffset(7), dayOffset(30)]);

  const active = await req('GET', '/highlights/active');
  assert.ok(!active.body.highlights.some((h) => h.target_id === articleId),
    'a scheduled highlight waits for its start date');
});

test('an expired highlight stops being shown', async () => {
  const articleId = await makeArticle(memberId, 'Ran Last Month');
  await pool.query(
    `INSERT INTO highlights (target_type, target_id, status, start_date, end_date)
     VALUES ('article', $1, 'approved', $2, $3)`,
    [articleId, dayOffset(-40), dayOffset(-1)]);

  const active = await req('GET', '/highlights/active');
  assert.ok(!active.body.highlights.some((h) => h.target_id === articleId),
    'a run that has ended is over — the site must stop giving it away free');
});

test('a highlight is shown on its last day, not dropped a day early', async () => {
  // end_date is inclusive. Someone who paid for 7 days gets 7 days.
  const articleId = await makeArticle(memberId, 'Ends Today');
  await pool.query(
    `INSERT INTO highlights (target_type, target_id, status, start_date, end_date)
     VALUES ('article', $1, 'approved', $2, $3)`,
    [articleId, dayOffset(-6), dayOffset(0)]);

  const active = await req('GET', '/highlights/active');
  assert.ok(active.body.highlights.some((h) => h.target_id === articleId),
    'the final day of a paid run still counts');
});

test('a highlight with no end date runs indefinitely', async () => {
  // Editorial highlights are often open-ended; NULL means no restriction.
  const articleId = await makeArticle(adminId, 'Evergreen');
  await pool.query(
    `INSERT INTO highlights (target_type, target_id, status, start_date, end_date, is_admin)
     VALUES ('article', $1, 'approved', NULL, NULL, true)`, [articleId]);

  const active = await req('GET', '/highlights/active');
  assert.ok(active.body.highlights.some((h) => h.target_id === articleId));
});

test('/active is ordered by the admin’s priority', async () => {
  const first = await makeArticle(adminId, 'Should Be First');
  const second = await makeArticle(adminId, 'Should Be Second');
  await pool.query(
    `INSERT INTO highlights (target_type, target_id, status, priority, is_admin)
     VALUES ('article', $1, 'approved', -99, true), ('article', $2, 'approved', 99, true)`,
    [first, second]);

  const active = await req('GET', '/highlights/active');
  const ids = active.body.highlights.map((h) => h.target_id);
  assert.ok(ids.indexOf(first) < ids.indexOf(second),
    'lower priority number is shown first, so the admin can control the running order');
});

// ---------------------------------------------------------------------------
// Admin editorial highlights
// ---------------------------------------------------------------------------

test('an admin highlight is live immediately, with no payment', async () => {
  const articleId = await makeArticle(memberId, 'Editors Pick');
  const created = await req('POST', '/highlights/admin', {
    token: adminToken,
    body: { targetType: 'article', targetId: articleId, priority: 5 },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.highlight.status, 'approved');
  assert.equal(created.body.highlight.is_admin, true);

  const active = await req('GET', '/highlights/active');
  assert.ok(active.body.highlights.some((h) => h.target_id === articleId));
});

test('an admin cannot highlight something that does not exist', async () => {
  const bad = await req('POST', '/highlights/admin', {
    token: adminToken, body: { targetType: 'article', targetId: 99999999 },
  });
  assert.equal(bad.status, 404, 'a highlight pointing at nothing would render as a blank card');
});

test('the target type must be one the site knows how to render', async () => {
  const bad = await req('POST', '/highlights/admin', {
    token: adminToken, body: { targetType: 'spaceship', targetId: 1 },
  });
  assert.equal(bad.status, 400);
});

test('an admin can take a highlight down by setting it to rejected', async () => {
  const articleId = await makeArticle(memberId, 'Taken Down');
  const created = await req('POST', '/highlights/admin', {
    token: adminToken, body: { targetType: 'article', targetId: articleId },
  });

  const patched = await req('PATCH', `/highlights/admin/${created.body.highlight.id}`, {
    token: adminToken, body: { status: 'rejected' },
  });
  assert.equal(patched.status, 200);

  const active = await req('GET', '/highlights/active');
  assert.ok(!active.body.highlights.some((h) => h.target_id === articleId),
    'the take-down is immediate — this is the button used when something must come off the site now');
});

test('clearing a date field sends it back to "no restriction"', async () => {
  // The admin UI submits an empty string for a cleared date input. That has to
  // become NULL, not an invalid date that breaks the whole /active query.
  const articleId = await makeArticle(memberId, 'Open Ended');
  const created = await req('POST', '/highlights/admin', {
    token: adminToken,
    body: { targetType: 'article', targetId: articleId, endDate: dayOffset(3) },
  });

  const patched = await req('PATCH', `/highlights/admin/${created.body.highlight.id}`, {
    token: adminToken, body: { endDate: '' },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.highlight.end_date, null);

  const active = await req('GET', '/highlights/active');
  assert.ok(active.body.highlights.some((h) => h.target_id === articleId));
});

test('a PATCH with nothing usable in it is refused rather than silently doing nothing', async () => {
  const articleId = await makeArticle(memberId, 'No Op');
  const created = await req('POST', '/highlights/admin', {
    token: adminToken, body: { targetType: 'article', targetId: articleId },
  });
  const empty = await req('PATCH', `/highlights/admin/${created.body.highlight.id}`, {
    token: adminToken, body: { somethingElse: 'x' },
  });
  assert.equal(empty.status, 400);
  assert.match(empty.body.error, /nothing to update/i);
});

test('an invalid status is ignored rather than written to the database', async () => {
  const articleId = await makeArticle(memberId, 'Bad Status');
  const created = await req('POST', '/highlights/admin', {
    token: adminToken, body: { targetType: 'article', targetId: articleId },
  });
  const bad = await req('PATCH', `/highlights/admin/${created.body.highlight.id}`, {
    token: adminToken, body: { status: 'live-ish' },
  });
  // Nothing valid was supplied, so there is nothing to update.
  assert.equal(bad.status, 400);

  const row = await pool.query('SELECT status FROM highlights WHERE id = $1', [created.body.highlight.id]);
  assert.equal(row.rows[0].status, 'approved', 'the status is untouched');
});

test('deleting a highlight removes it; deleting it twice is a clean 404', async () => {
  const articleId = await makeArticle(memberId, 'To Delete');
  const created = await req('POST', '/highlights/admin', {
    token: adminToken, body: { targetType: 'article', targetId: articleId },
  });
  const id = created.body.highlight.id;

  const gone = await req('DELETE', `/highlights/admin/${id}`, { token: adminToken });
  assert.equal(gone.status, 200);

  const again = await req('DELETE', `/highlights/admin/${id}`, { token: adminToken });
  assert.equal(again.status, 404, 'a double-click on Delete says so plainly rather than erroring');
});

test('/admin/all lists the target’s title so the admin knows what they are looking at', async () => {
  const articleId = await makeArticle(memberId, 'Recognisable Title');
  await req('POST', '/highlights/admin', {
    token: adminToken, body: { targetType: 'article', targetId: articleId },
  });
  const all = await req('GET', '/highlights/admin/all', { token: adminToken });
  assert.equal(all.status, 200);
  const row = all.body.highlights.find((h) => h.target_id === articleId);
  assert.equal(row.target_title, 'Recognisable Title');
});

test('the admin endpoints are admin-only', async () => {
  for (const [method, urlPath] of [
    ['GET', '/highlights/admin/all'],
    ['POST', '/highlights/admin'],
    ['PATCH', '/highlights/admin/1'],
    ['DELETE', '/highlights/admin/1'],
  ]) {
    // fetch() refuses a body on GET, so only send one where it is allowed.
    const body = method === 'GET' ? undefined : {};
    const asMember = await req(method, urlPath, { token: memberToken, body });
    assert.equal(asMember.status, 403, `${method} ${urlPath} must refuse a member`);
    const asAnon = await req(method, urlPath, { body });
    assert.equal(asAnon.status, 401, `${method} ${urlPath} must refuse a stranger`);
  }
});

// ---------------------------------------------------------------------------
// Member purchases
// ---------------------------------------------------------------------------

test('A MEMBER CANNOT HIGHLIGHT SOMEBODY ELSE’S ARTICLE', async () => {
  const otherId = await makeUser();
  const theirArticle = await makeArticle(otherId, 'Not Yours');

  const refused = await req('POST', '/highlights', {
    token: memberToken,
    body: { targetType: 'article', targetId: theirArticle, durationDays: 7 },
  });
  assert.equal(refused.status, 403);
});

test('a member highlight starts unpaid — it is not live on creation', async () => {
  const articleId = await makeArticle(memberId, 'My Own Story');
  const created = await req('POST', '/highlights', {
    token: memberToken,
    body: { targetType: 'article', targetId: articleId, durationDays: 7 },
  });
  assert.equal(created.status, 201);
  assert.notEqual(created.body.highlight.status, 'approved',
    'creating a request must not be the same as paying for one');

  const active = await req('GET', '/highlights/active');
  assert.ok(!active.body.highlights.some((h) => h.target_id === articleId));
});

test('a member can highlight their own Directory profile', async () => {
  const profileId = await makeProfile(memberId, 'My Business');
  const created = await req('POST', '/highlights', {
    token: memberToken,
    body: { targetType: 'directory', targetId: profileId, durationDays: 14 },
  });
  assert.equal(created.status, 201);
});

test('only real durations can be requested', async () => {
  const articleId = await makeArticle(memberId, 'Duration Test');
  const bad = await req('POST', '/highlights', {
    token: memberToken,
    body: { targetType: 'article', targetId: articleId, durationDays: 365 },
  });
  assert.equal(bad.status, 400, 'a year-long highlight at the 7-day price would be a real loss');
});

test('a start date in the past is refused', async () => {
  const articleId = await makeArticle(memberId, 'Backdated');
  const bad = await req('POST', '/highlights', {
    token: memberToken,
    body: {
      targetType: 'article', targetId: articleId, durationDays: 7,
      requestedStartDate: dayOffset(-5),
    },
  });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /past/i);
});

test('a malformed start date is refused before it reaches the database', async () => {
  const articleId = await makeArticle(memberId, 'Bad Date');
  const bad = await req('POST', '/highlights', {
    token: memberToken,
    body: {
      targetType: 'article', targetId: articleId, durationDays: 7,
      requestedStartDate: 'next Tuesday',
    },
  });
  assert.equal(bad.status, 400);
});

test('a future start date is accepted and kept', async () => {
  const articleId = await makeArticle(memberId, 'Scheduled Buy');
  const wanted = dayOffset(10);
  const created = await req('POST', '/highlights', {
    token: memberToken,
    body: {
      targetType: 'article', targetId: articleId, durationDays: 7,
      requestedStartDate: wanted,
    },
  });
  assert.equal(created.status, 201);
  const row = await pool.query(
    `SELECT to_char(requested_start_date, 'YYYY-MM-DD') AS d FROM highlights WHERE id = $1`,
    [created.body.highlight.id]);
  // Formatted in SQL: reading a DATE into a JS Date lands on LOCAL midnight,
  // which in SAST reports the previous day once converted back to UTC.
  assert.equal(row.rows[0].d, wanted);
});

test('highlighting something that does not exist is a 404, not a 500', async () => {
  const missing = await req('POST', '/highlights', {
    token: memberToken,
    body: { targetType: 'article', targetId: 99999999, durationDays: 7 },
  });
  assert.equal(missing.status, 404);
});

test('buying a highlight requires signing in', async () => {
  const anon = await req('POST', '/highlights', {
    body: { targetType: 'article', targetId: 1, durationDays: 7 },
  });
  assert.equal(anon.status, 401);
});

// ---------------------------------------------------------------------------
// What the member sees on their own dashboard
// ---------------------------------------------------------------------------

test('/mine shows your highlights and nobody else’s', async () => {
  const otherId = await makeUser();
  const otherToken = tokenFor(otherId);
  const theirArticle = await makeArticle(otherId, 'Their Story');
  await req('POST', '/highlights', {
    token: otherToken,
    body: { targetType: 'article', targetId: theirArticle, durationDays: 7 },
  });

  const mine = await req('GET', '/highlights/mine', { token: memberToken });
  assert.equal(mine.status, 200);
  assert.ok(mine.body.highlights.length > 0);
  assert.ok(mine.body.highlights.every((h) => h.target_title !== 'Their Story'),
    'one member must never see another member’s promotions');
});

test('/mine labels each highlight with a state a member can understand', async () => {
  // The labels are derived server-side precisely so the dashboard cannot
  // invent its own rules and disagree with the site.
  const articleId = await makeArticle(memberId, 'Label Check');
  const r = await pool.query(
    `INSERT INTO highlights (target_type, target_id, status, start_date, end_date, duration_days)
     VALUES ('article', $1, 'approved', $2, $3, 7) RETURNING id`,
    [articleId, dayOffset(7), dayOffset(14)]);

  const mine = await req('GET', '/highlights/mine', { token: memberToken });
  const row = mine.body.highlights.find((h) => h.id === r.rows[0].id);
  assert.equal(row.statusLabel, 'Scheduled', 'a paid run that has not begun reads as Scheduled');
});

test('/mine counts the days left on a live highlight', async () => {
  const articleId = await makeArticle(memberId, 'Days Left Check');
  const r = await pool.query(
    `INSERT INTO highlights (target_type, target_id, status, start_date, end_date, duration_days)
     VALUES ('article', $1, 'approved', $2, $3, 7) RETURNING id`,
    [articleId, dayOffset(-2), dayOffset(4)]);

  const mine = await req('GET', '/highlights/mine', { token: memberToken });
  const row = mine.body.highlights.find((h) => h.id === r.rows[0].id);
  assert.equal(row.statusLabel, 'Active');
  assert.equal(row.daysLeft, 4, 'the member can see exactly what they have left');
});

test('/mine requires signing in', async () => {
  const anon = await req('GET', '/highlights/mine');
  assert.equal(anon.status, 401);
});
