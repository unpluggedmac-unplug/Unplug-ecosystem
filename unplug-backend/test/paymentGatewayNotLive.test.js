// The frontend disables PayFast and Ozow everywhere as "coming soon" — every
// payment-method <select> on the site ships them as `disabled` options. Until
// now the BACKEND didn't agree: POST /payments/initiate accepted
// method: 'payfast'/'ozow' regardless, and handed back a stub redirect to a
// fake domain (sandbox.payfast.example.com) that goes nowhere. Reachable by
// removing a `disabled` attribute in devtools, or a direct API call —
// bypassing the frontend's own restriction entirely.
//
// Website remediation punch-list (2026-09-03), PAY-001/PAY-005.
//
// Fixed by gating on the SAME env vars the webhook signature verifiers
// already require for a real merchant account (PAYFAST_PASSPHRASE,
// OZOW_PRIVATE_KEY) — not a separate flag that could drift out of sync with
// whether credentials actually exist.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-gwlive-'));
const port = 25600 + (process.pid % 300); // bases 400 apart across test files

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
  return jwt.sign({ id: userId, email: `gwlive${userId}@test.com`, role }, process.env.JWT_SECRET);
}

let _nextUserId = 28000;
async function makeUser(role = 'member') {
  const id = _nextUserId++;
  await pool.query(`INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', $3) ON CONFLICT DO NOTHING`, [id, `gwlive${id}@test.com`, role]);
  return id;
}

async function makeAwaitingEvent(userId) {
  const r = await pool.query(
    `INSERT INTO events (organizer_user_id, name, event_date, status) VALUES ($1, 'Gateway Test Event', CURRENT_DATE + 30, 'awaiting_payment') RETURNING id`,
    [userId]
  );
  return r.rows[0].id;
}

function initiateBody(eventId, method) {
  return { linkedType: 'event_listing', linkedId: eventId, method, termsAccepted: true, useCredit: false };
}

before(async () => {
  // Neither credential is set for this whole file — that IS the scenario
  // being tested (today's real production state: no merchant account yet).
  delete process.env.PAYFAST_PASSPHRASE;
  delete process.env.OZOW_PRIVATE_KEY;

  pg = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'postgres', password: 'postgres', port,
    persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('unplug_test');

  process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${port}/unplug_test`;
  process.env.JWT_SECRET = 'test-secret-for-gwlive';

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

test('WITH NO MERCHANT CREDENTIALS CONFIGURED, PAYFAST IS REFUSED — NOT A STUB SUCCESS', async () => {
  const user = await makeUser();
  const eventId = await makeAwaitingEvent(user);

  const { status, body } = await req('POST', '/payments/initiate', {
    token: tokenFor(user), body: initiateBody(eventId, 'payfast'),
  });
  assert.equal(status, 400);
  assert.match(body.error, /coming soon/i);
  assert.ok(!body.redirectUrl, 'must not receive a fake redirect link');

  const rows = await pool.query(`SELECT count(*)::int AS n FROM payments WHERE linked_type = 'event_listing' AND linked_id = $1`, [eventId]);
  assert.equal(rows.rows[0].n, 0, 'no payment row is created for a refused method');
});

test('SAME FOR OZOW, WITH NO OZOW_PRIVATE_KEY CONFIGURED', async () => {
  const user = await makeUser();
  const eventId = await makeAwaitingEvent(user);

  const { status, body } = await req('POST', '/payments/initiate', {
    token: tokenFor(user), body: initiateBody(eventId, 'ozow'),
  });
  assert.equal(status, 400);
  assert.match(body.error, /coming soon/i);
});

test('EFT IS UNAFFECTED — NO MERCHANT ACCOUNT IS NEEDED FOR IT', async () => {
  const user = await makeUser();
  const eventId = await makeAwaitingEvent(user);

  const { status, body } = await req('POST', '/payments/initiate', {
    token: tokenFor(user), body: initiateBody(eventId, 'eft'),
  });
  assert.equal(status, 201);
  assert.ok(body.instructions);
});

test('THE MOMENT A MERCHANT CREDENTIAL IS CONFIGURED, THAT METHOD STARTS WORKING — NO CODE CHANGE NEEDED', async () => {
  const user = await makeUser();
  const eventId = await makeAwaitingEvent(user);

  process.env.PAYFAST_PASSPHRASE = 'now-configured';
  try {
    const { status, body } = await req('POST', '/payments/initiate', {
      token: tokenFor(user), body: initiateBody(eventId, 'payfast'),
    });
    assert.equal(status, 201);
    assert.ok(body.redirectUrl);
  } finally {
    delete process.env.PAYFAST_PASSPHRASE; // back to "not configured" for tests after this one
  }
});
