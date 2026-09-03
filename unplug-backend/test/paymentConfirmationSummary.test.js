// PAY-011: the checkout confirmation screen showed bank details or a
// redirect link and nothing else — no service name, no amount, no status,
// and no way back into the site (a dead end once you'd paid). A member had
// to already remember what they were buying and trust it went through.
//
// Fixed by having POST /payments/initiate return the same serviceLabel and
// statusLabel GET /payments/mine already computes for Payment History —
// via one shared paymentDisplayFields() helper, not two copies that could
// quietly drift apart — and having unplug-checkout.html's result screen
// render them, plus a "View My Order" link.
//
// Website remediation punch-list (2026-09-03).
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-paysummary-'));
const port = 61200 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

function migrationFiles() {
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
    .map((f) => path.join(dir, f));
}

async function req(method, urlPath, { token, body } = {}) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, body: json };
}

let _nextUserId = 61200;
async function makeUser() {
  const id = _nextUserId++;
  await pool.query(`INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', 'member') ON CONFLICT DO NOTHING`, [id, `paysummary${id}@test.com`]);
  return id;
}

function tokenFor(userId) {
  return jwt.sign({ id: userId, email: `paysummary${userId}@test.com`, role: 'member' }, process.env.JWT_SECRET);
}

async function makeAwaitingEvent(userId) {
  const r = await pool.query(
    `INSERT INTO events (organizer_user_id, name, event_date, status) VALUES ($1, 'Summary Test Event', CURRENT_DATE + 30, 'awaiting_payment') RETURNING id`,
    [userId]
  );
  return r.rows[0].id;
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
  process.env.JWT_SECRET = 'test-secret-for-paysummary';
  delete process.env.PAYFAST_PASSPHRASE;
  delete process.env.OZOW_PRIVATE_KEY;

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const file of migrationFiles()) {
    await pool.query(fs.readFileSync(file, 'utf8'));
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
}, { timeout: 120000 });

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ backend

test('A FRESH EFT PAYMENT RETURNS A HUMAN SERVICE NAME AND "AWAITING PAYMENT", NOT A RAW DB KEY', async () => {
  const user = await makeUser();
  const eventId = await makeAwaitingEvent(user);
  const { status, body } = await req('POST', '/payments/initiate', {
    token: tokenFor(user),
    body: { linkedType: 'event_listing', linkedId: eventId, method: 'eft', termsAccepted: true, useCredit: false },
  });
  assert.equal(status, 201);
  assert.equal(body.serviceLabel, 'Event Listing');
  assert.equal(body.statusLabel, 'Awaiting Payment');
  assert.ok(body.instructions, 'the EFT details must still be present alongside the new summary fields');
});

test('A PAYMENT FULLY COVERED BY ACCOUNT CREDIT REPORTS "PAID BY CREDIT" — NOT "AWAITING PAYMENT" FOR MONEY ALREADY SETTLED', async () => {
  const user = await makeUser();
  const eventId = await makeAwaitingEvent(user);
  await pool.query(
    `INSERT INTO account_credits (user_id, amount, reason) VALUES ($1, 500.00, 'admin_adjustment')`,
    [user]
  );
  const { status, body } = await req('POST', '/payments/initiate', {
    token: tokenFor(user),
    body: { linkedType: 'event_listing', linkedId: eventId, method: 'eft', termsAccepted: true, useCredit: true },
  });
  assert.equal(status, 201);
  assert.equal(body.paidInFull, true);
  assert.equal(body.statusLabel, 'Paid by Credit');
  assert.equal(body.serviceLabel, 'Event Listing');
});

test('RESUBMITTING A STILL-PENDING ORDER ALSO RETURNS THE SUMMARY FIELDS — NOT JUST THE FIRST-TIME PATH', async () => {
  const user = await makeUser();
  const eventId = await makeAwaitingEvent(user);
  const body = { linkedType: 'event_listing', linkedId: eventId, method: 'eft', termsAccepted: true, useCredit: false };
  await req('POST', '/payments/initiate', { token: tokenFor(user), body });
  const second = await req('POST', '/payments/initiate', { token: tokenFor(user), body });
  assert.equal(second.status, 200);
  assert.equal(second.body.alreadyPending, true);
  assert.equal(second.body.serviceLabel, 'Event Listing');
  assert.equal(second.body.statusLabel, 'Awaiting Payment');
});

test('GET /payments/mine SHOWS THE EXACT SAME LABELS THE CONFIRMATION SCREEN JUST SHOWED — ONE SOURCE, NOT TWO THAT COULD DISAGREE', async () => {
  const user = await makeUser();
  const eventId = await makeAwaitingEvent(user);
  const created = await req('POST', '/payments/initiate', {
    token: tokenFor(user),
    body: { linkedType: 'event_listing', linkedId: eventId, method: 'eft', termsAccepted: true, useCredit: false },
  });
  const mine = await req('GET', '/payments/mine', { token: tokenFor(user) });
  assert.equal(mine.status, 200);
  const row = mine.body.payments.find((p) => p.id === created.body.payment.id);
  assert.ok(row, 'the payment just created should appear in payment history');
  assert.equal(row.serviceLabel, created.body.serviceLabel);
  assert.equal(row.statusLabel, created.body.statusLabel);
});

// ------------------------------------------------------------------- frontend

function readCheckout() {
  const file = path.join(__dirname, '..', '..', 'unplug-checkout.html');
  assert.ok(fs.existsSync(file), 'unplug-checkout.html should exist');
  return fs.readFileSync(file, 'utf8').split('\r\n').join('\n');
}

test('THE CONFIRMATION SCREEN RENDERS THE SERVICE, ORDER TOTAL AND STATUS FROM THE RESPONSE, NOT JUST THE PAYMENT INSTRUCTIONS', () => {
  const src = readCheckout();
  const idx = src.indexOf("getElementById('resultOrderMeta')");
  assert.ok(idx > -1, 'the checkout page must populate the new order-meta summary');
  const block = src.slice(idx, idx + 400);
  assert.match(block, /data\.serviceLabel/);
  assert.match(block, /data\.payment\.order_total/);
  assert.match(block, /data\.statusLabel/);
});

test('THE CONFIRMATION SCREEN OFFERS A WAY BACK INTO THE SITE — NOT A DEAD END AFTER PAYING', () => {
  const src = readCheckout();
  const start = src.indexOf('id="resultCard"');
  assert.ok(start > -1);
  const block = src.slice(start, start + 1400);
  assert.match(block, /View My Order/i);
  assert.match(block, /unplug-member-dashboard\.html/);
});
