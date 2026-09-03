// A double-click, a resubmit after Back, or two open tabs must not create
// two real payment rows for one purchase.
//
// Website-remediation punch-list (2026-09-03), PAY-009. Confirmed live in the
// code before this fix: POST /payments/initiate had no such guard for any
// linkedType except ad_banner (which checks its own moderation_status field,
// not a general mechanism). Every other purchase — directory packages,
// highlights, competition entries, event listings, and so on — could be paid
// for twice with nothing stopping it.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-paydupe-'));
const port = 25200 + (process.pid % 300); // bases 400 apart across test files

async function req(method, urlPath, { token, body } = {}) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, body: json };
}

let jwt;
function tokenFor(userId, role = 'member') {
  return jwt.sign({ id: userId, email: `paydupe${userId}@test.com`, role }, process.env.JWT_SECRET);
}

let _nextUserId = 27000;
async function makeUser(role = 'member') {
  const id = _nextUserId++;
  await pool.query(`INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', $3) ON CONFLICT DO NOTHING`, [id, `paydupe${id}@test.com`, role]);
  return id;
}

// Event Listing (flat R300, resolveAmount reads only existence) — the
// simplest fixture that needs no service_packages/voucher/credit setup.
async function makeAwaitingEvent(userId) {
  const r = await pool.query(
    `INSERT INTO events (organizer_user_id, name, event_date, status) VALUES ($1, 'Dupe-Guard Test Event', CURRENT_DATE + 30, 'awaiting_payment') RETURNING id`,
    [userId]
  );
  return r.rows[0].id;
}

function initiateBody(eventId, overrides = {}) {
  return {
    linkedType: 'event_listing', linkedId: eventId, method: 'eft',
    termsAccepted: true, useCredit: false,
    ...overrides,
  };
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
  process.env.JWT_SECRET = 'test-secret-for-paydupe';

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
  app.use('/payments', require('../src/routes/payments'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await pool.end();
  await stopPostgres(pg, dataDir);
});

test('CLICKING PAY TWICE DOES NOT CREATE TWO PAYMENT ROWS', async () => {
  const user = await makeUser();
  const eventId = await makeAwaitingEvent(user);
  const token = tokenFor(user);

  const first = await req('POST', '/payments/initiate', { token, body: initiateBody(eventId) });
  assert.equal(first.status, 201);
  const reference = first.body.payment.gateway_reference;

  const second = await req('POST', '/payments/initiate', { token, body: initiateBody(eventId) });
  assert.equal(second.status, 200, 'the resubmit is not an error — it hands back the existing order');
  assert.equal(second.body.alreadyPending, true);
  assert.equal(second.body.payment.gateway_reference, reference, 'same reference both times, not a new one');
  assert.ok(second.body.instructions, 'still gets the EFT instructions to pay against');

  const rows = await pool.query(
    `SELECT count(*)::int AS n FROM payments WHERE linked_type = 'event_listing' AND linked_id = $1`, [eventId]);
  assert.equal(rows.rows[0].n, 1, 'exactly one payment row, not two');
});

test('A THIRD (OR TENTH) RESUBMIT STILL RETURNS THE SAME ORDER', async () => {
  const user = await makeUser();
  const eventId = await makeAwaitingEvent(user);
  const token = tokenFor(user);

  const first = await req('POST', '/payments/initiate', { token, body: initiateBody(eventId) });
  for (let i = 0; i < 3; i += 1) {
    const again = await req('POST', '/payments/initiate', { token, body: initiateBody(eventId) });
    assert.equal(again.body.payment.gateway_reference, first.body.payment.gateway_reference);
  }
  const rows = await pool.query(
    `SELECT count(*)::int AS n FROM payments WHERE linked_type = 'event_listing' AND linked_id = $1`, [eventId]);
  assert.equal(rows.rows[0].n, 1);
});

test('ONCE CONFIRMED, TRYING TO PAY AGAIN IS REFUSED OUTRIGHT', async () => {
  const user = await makeUser();
  const eventId = await makeAwaitingEvent(user);
  const token = tokenFor(user);

  const first = await req('POST', '/payments/initiate', { token, body: initiateBody(eventId) });
  await pool.query(`UPDATE payments SET status = 'confirmed', confirmed_at = now() WHERE id = $1`, [first.body.payment.id]);

  const again = await req('POST', '/payments/initiate', { token, body: initiateBody(eventId) });
  assert.equal(again.status, 400);
  assert.match(again.body.error, /already been paid/);

  const rows = await pool.query(
    `SELECT count(*)::int AS n FROM payments WHERE linked_type = 'event_listing' AND linked_id = $1`, [eventId]);
  assert.equal(rows.rows[0].n, 1, 'refused, not silently given a second row');
});

test('A FAILED PAYMENT DOES NOT PERMANENTLY BLOCK A FRESH ATTEMPT', async () => {
  const user = await makeUser();
  const eventId = await makeAwaitingEvent(user);
  const token = tokenFor(user);

  const first = await req('POST', '/payments/initiate', { token, body: initiateBody(eventId) });
  await pool.query(`UPDATE payments SET status = 'failed' WHERE id = $1`, [first.body.payment.id]);

  const retry = await req('POST', '/payments/initiate', { token, body: initiateBody(eventId) });
  assert.equal(retry.status, 201, 'a genuinely new attempt, not the guard kicking in');
  assert.notEqual(retry.body.payment.gateway_reference, first.body.payment.gateway_reference);

  const rows = await pool.query(
    `SELECT count(*)::int AS n FROM payments WHERE linked_type = 'event_listing' AND linked_id = $1`, [eventId]);
  assert.equal(rows.rows[0].n, 2, 'the failed attempt and the retry both exist — this is not the case the guard covers');
});

test('BUYING TWO DIFFERENT THINGS IS NOT MISTAKEN FOR A DUPLICATE', async () => {
  const user = await makeUser();
  const eventA = await makeAwaitingEvent(user);
  const eventB = await makeAwaitingEvent(user);
  const token = tokenFor(user);

  const a = await req('POST', '/payments/initiate', { token, body: initiateBody(eventA) });
  const b = await req('POST', '/payments/initiate', { token, body: initiateBody(eventB) });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201, 'a second, genuinely different purchase is never blocked');
  assert.notEqual(a.body.payment.gateway_reference, b.body.payment.gateway_reference);
});

test("THE GUARD IS PER USER — SOMEONE ELSE'S PENDING ORDER NEVER BLOCKS YOURS", async () => {
  // Not a realistic path (linkedId ownership is enforced elsewhere for
  // owned resources), but the query itself is scoped by user_id and that
  // scoping is what this proves directly.
  const buyer = await makeUser();
  const otherUser = await makeUser();
  const eventId = await makeAwaitingEvent(buyer);

  await req('POST', '/payments/initiate', { token: tokenFor(buyer), body: initiateBody(eventId) });
  const attempt = await req('POST', '/payments/initiate', { token: tokenFor(otherUser), body: initiateBody(eventId) });
  assert.equal(attempt.status, 201, "a different user's request for the same linkedId is not treated as their duplicate");
});

test('PayFast/Ozow resubmits are also caught — the guard is not EFT-only', async () => {
  const user = await makeUser();
  const eventId = await makeAwaitingEvent(user);
  const token = tokenFor(user);

  const first = await req('POST', '/payments/initiate', { token, body: initiateBody(eventId, { method: 'payfast' }) });
  assert.equal(first.status, 201);
  const second = await req('POST', '/payments/initiate', { token, body: initiateBody(eventId, { method: 'payfast' }) });
  assert.equal(second.status, 200);
  assert.equal(second.body.alreadyPending, true);
  assert.ok(second.body.redirectUrl, 'still gets a redirect URL, not just an error');

  const rows = await pool.query(
    `SELECT count(*)::int AS n FROM payments WHERE linked_type = 'event_listing' AND linked_id = $1`, [eventId]);
  assert.equal(rows.rows[0].n, 1);
});
