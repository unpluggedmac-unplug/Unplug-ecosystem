// Sign-up and email verification, against a REAL PostgreSQL.
//
// There were no tests on registration at all before this, which is a strange
// gap for the one flow every member goes through exactly once and can never
// retry cleanly if it goes wrong.
//
// What this protects:
//
//   1. A CONTACT NUMBER IS ACTUALLY REQUIRED. The sign-up form has always
//      asked for one, but only in the browser — and a rule enforced only in
//      the browser is not enforced, because anything can POST to /auth/register.
//      Accounts could exist with no way to reach the person behind them.
//   2. SOUTH AFRICAN NUMBERS IN THE FORMS PEOPLE ACTUALLY TYPE. 082 123 4567
//      and +27 82 123 4567 are the same number. Rejecting a real number over a
//      space would be a worse failure than accepting odd punctuation.
//   3. TWO STEPS, AND THE SECOND ONE MATTERS. An account is not usable until
//      the emailed code is entered: sign-in is refused until then.
//   4. A CODE IS USED ONCE. Replaying it must not work.
//
// Run with:  npm test   (from unplug-backend/)

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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-signup-'));
const port = 43600 + (process.pid % 300); // bases are 400 apart so ranges cannot overlap

const migrationsDir = path.join(__dirname, '..', 'db', 'migrations');
async function runMigrations() {
  for (const f of fs.readdirSync(migrationsDir).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(migrationsDir, f), 'utf8'));
  }
}

async function api(method, urlPath, body) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

let n = 0;
const freshEmail = () => `signup${Date.now()}_${n++}@test.com`;
const GOOD = { password: 'a-good-password', phone: '082 123 4567', fullName: 'Test Person' };

const codeFor = async (email) => (await pool.query(
  `SELECT c.code FROM email_verification_codes c
     JOIN users u ON u.id = c.user_id
    WHERE u.email = $1 AND c.used_at IS NULL
    ORDER BY c.id DESC LIMIT 1`, [email])).rows[0].code;

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
  process.env.JWT_SECRET = 'test-secret-for-signup';
  process.env.UNPLUG_DISABLE_RATE_LIMITS = '1';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await runMigrations();

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/auth', require('../src/routes/auth'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
});

// ------------------------------------------------------- the contact number

test('A CONTACT NUMBER IS REQUIRED, AND THE SERVER IS WHERE THAT IS DECIDED', async () => {
  const email = freshEmail();
  const { status, body } = await api('POST', '/auth/register',
    { email, password: GOOD.password, fullName: 'No Phone' });
  assert.equal(status, 400);
  assert.match(body.error, /contact number/i);

  const rows = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  assert.equal(rows.rows.length, 0, 'and no account is left behind');
});

test('an empty or whitespace number is not a number', async () => {
  for (const phone of ['', '   ', null]) {
    const { status } = await api('POST', '/auth/register',
      { email: freshEmail(), password: GOOD.password, phone });
    assert.equal(status, 400, JSON.stringify(phone) + ' must be refused');
  }
});

test('SOUTH AFRICAN NUMBERS IN THE FORMS PEOPLE ACTUALLY TYPE', async () => {
  // All the same number. Rejecting one of these because of a space would be a
  // worse failure than accepting odd punctuation.
  for (const phone of ['0821234567', '082 123 4567', '+27 82 123 4567', '(082) 123-4567', '+27821234567']) {
    const { status, body } = await api('POST', '/auth/register',
      { email: freshEmail(), password: GOOD.password, phone, fullName: 'Fine' });
    assert.equal(status, 201, phone + ' should be accepted, got ' + JSON.stringify(body));
  }
});

test('but obvious nonsense is refused', async () => {
  for (const phone of ['abc', '12345', '<script>alert(1)</script>', 'not a number']) {
    const { status } = await api('POST', '/auth/register',
      { email: freshEmail(), password: GOOD.password, phone });
    assert.equal(status, 400, JSON.stringify(phone) + ' must be refused');
  }
});

test('the number is stored, trimmed, against the account', async () => {
  const email = freshEmail();
  await api('POST', '/auth/register', { email, ...GOOD, phone: '  082 999 0000  ' });
  const r = await pool.query('SELECT phone FROM users WHERE email = $1', [email]);
  assert.equal(r.rows[0].phone, '082 999 0000');
});

// ------------------------------------------------------------ the two steps

test('STEP ONE creates an unverified account and a code', async () => {
  const email = freshEmail();
  const { status, body } = await api('POST', '/auth/register', { email, ...GOOD });
  assert.equal(status, 201);
  assert.ok(body.user.id);

  const u = await pool.query('SELECT email_verified FROM users WHERE email = $1', [email]);
  assert.notEqual(u.rows[0].email_verified, true, 'not usable yet');
  assert.ok(await codeFor(email), 'a code was issued');
});

test('STEP TWO IS NOT OPTIONAL — sign-in is refused until the code is entered', async () => {
  const email = freshEmail();
  await api('POST', '/auth/register', { email, ...GOOD });
  const { status, body } = await api('POST', '/auth/login', { email, password: GOOD.password });
  assert.equal(status, 403, 'an unverified account cannot sign in');
  assert.match(body.error, /verify/i);
});

test('the right code activates the account, and then sign-in works', async () => {
  const email = freshEmail();
  await api('POST', '/auth/register', { email, ...GOOD });
  const code = await codeFor(email);

  const verify = await api('POST', '/auth/verify-email', { email, code });
  assert.equal(verify.status, 200);

  const login = await api('POST', '/auth/login', { email, password: GOOD.password });
  assert.equal(login.status, 200);
  assert.ok(login.body.token, 'and a session is issued');
});

test('a wrong code does not activate anything', async () => {
  const email = freshEmail();
  await api('POST', '/auth/register', { email, ...GOOD });
  const { status } = await api('POST', '/auth/verify-email', { email, code: '000000' });
  assert.notEqual(status, 200);
  const u = await pool.query('SELECT email_verified FROM users WHERE email = $1', [email]);
  assert.notEqual(u.rows[0].email_verified, true);
});

test('A CODE IS USED ONCE', async () => {
  const email = freshEmail();
  await api('POST', '/auth/register', { email, ...GOOD });
  const code = await codeFor(email);
  assert.equal((await api('POST', '/auth/verify-email', { email, code })).status, 200);
  const replay = await api('POST', '/auth/verify-email', { email, code });
  assert.notEqual(replay.status, 200, 'replaying a used code must not work');
});

test('an expired code is refused', async () => {
  const email = freshEmail();
  await api('POST', '/auth/register', { email, ...GOOD });
  const code = await codeFor(email);
  await pool.query(
    `UPDATE email_verification_codes SET expires_at = now() - interval '1 minute'
      WHERE user_id = (SELECT id FROM users WHERE email = $1)`, [email]);
  const { status } = await api('POST', '/auth/verify-email', { email, code });
  assert.notEqual(status, 200);
});

// --------------------------------------------------------------- the basics

test('a duplicate email is refused', async () => {
  const email = freshEmail();
  assert.equal((await api('POST', '/auth/register', { email, ...GOOD })).status, 201);
  assert.equal((await api('POST', '/auth/register', { email, ...GOOD })).status, 409);
});

test('a short password is refused, and no account is created', async () => {
  const email = freshEmail();
  const { status } = await api('POST', '/auth/register', { email, password: 'short', phone: GOOD.phone });
  assert.equal(status, 400);
  assert.equal((await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows.length, 0);
});

test('a bad email address is refused', async () => {
  const { status } = await api('POST', '/auth/register',
    { email: 'not-an-email', password: GOOD.password, phone: GOOD.phone });
  assert.equal(status, 400);
});

test('THE PASSWORD IS NEVER STORED AS TYPED, AND NEVER RETURNED', async () => {
  const email = freshEmail();
  const { body } = await api('POST', '/auth/register', { email, ...GOOD });
  assert.equal(JSON.stringify(body).indexOf(GOOD.password), -1, 'not in the response');
  const r = await pool.query('SELECT password_hash FROM users WHERE email = $1', [email]);
  assert.notEqual(r.rows[0].password_hash, GOOD.password);
  assert.match(r.rows[0].password_hash, /^\$2[aby]\$/, 'stored as a bcrypt hash');
});
