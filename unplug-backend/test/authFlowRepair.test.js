const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const bcrypt = require('bcryptjs');
const EmbeddedPostgres = require('embedded-postgres').default;
const { stopPostgres } = require('./helpers/stopPostgres');
const { ensureStopWords } = require('./helpers/textSearch');

let pg;
let pool;
let server;
let baseUrl;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-auth-repair-'));
const port = 45100 + (process.pid % 300);

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
function email(prefix = 'authrepair') {
  n += 1;
  return `${prefix}${Date.now()}_${n}@test.com`;
}

async function insertVerifiedUser({ address, password = 'correct-horse-battery', phone = null }) {
  const hash = await bcrypt.hash(password, 10);
  const r = await pool.query(
    `INSERT INTO users (email, phone, password_hash, role, full_name, email_verified)
     VALUES ($1, $2, $3, 'member', 'Auth Repair Test', true)
     RETURNING id`,
    [address, phone, hash]
  );
  return r.rows[0].id;
}

before(async () => {
  ensureStopWords();
  pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: false,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('unplug_test');

  process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${port}/unplug_test`;
  process.env.JWT_SECRET = 'auth-repair-test-secret';
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

test('password reset now issues exactly six numeric digits', async () => {
  const address = email('resetcode');
  const userId = await insertVerifiedUser({ address });

  const forgot = await api('POST', '/auth/forgot-password', { email: address });
  assert.equal(forgot.status, 200);
  assert.match(forgot.body.message, /6-digit/i);

  const row = await pool.query(
    `SELECT token FROM password_reset_tokens
      WHERE user_id = $1 AND used_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  assert.equal(row.rowCount, 1);
  assert.match(row.rows[0].token, /^\d{6}$/);
});

test('six-digit reset code only works with the email that requested it', async () => {
  const address = email('resetowner');
  const wrongAddress = email('resetwrong');
  const userId = await insertVerifiedUser({ address });
  await insertVerifiedUser({ address: wrongAddress });

  await api('POST', '/auth/forgot-password', { email: address });
  const row = await pool.query(
    `SELECT token FROM password_reset_tokens
      WHERE user_id = $1 AND used_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  const code = row.rows[0].token;

  const wrong = await api('POST', '/auth/reset-password', {
    email: wrongAddress,
    code,
    newPassword: 'brand-new-password',
  });
  assert.equal(wrong.status, 400);

  const right = await api('POST', '/auth/reset-password', {
    email: address,
    code,
    newPassword: 'brand-new-password',
  });
  assert.equal(right.status, 200);

  const login = await api('POST', '/auth/login', {
    email: address,
    password: 'brand-new-password',
  });
  assert.equal(login.status, 200);
  assert.ok(login.body.token);
});

test('email sign-in ignores accidental capital letters and surrounding spaces', async () => {
  const address = email('case').toLowerCase();
  await insertVerifiedUser({ address });

  const login = await api('POST', '/auth/login', {
    email: `  ${address.toUpperCase()}  `,
    password: 'correct-horse-battery',
  });
  assert.equal(login.status, 200);
  assert.ok(login.body.token);
});

test('members can sign in with a South African cell number', async () => {
  const address = email('phone');
  await insertVerifiedUser({ address, phone: '082 555 1234' });

  const local = await api('POST', '/auth/login', {
    email: '0825551234',
    password: 'correct-horse-battery',
  });
  assert.equal(local.status, 200);
  assert.ok(local.body.token);

  const intl = await api('POST', '/auth/login', {
    email: '+27 82 555 1234',
    password: 'correct-horse-battery',
  });
  assert.equal(intl.status, 200);
  assert.ok(intl.body.token);
});

test('an unverified member who tries to register again gets a verification recovery, not a duplicate account', async () => {
  const address = email('unfinished');
  const payload = {
    email: address,
    password: 'a-good-password',
    phone: '083 222 1122',
    fullName: 'Unfinished Member',
  };

  const first = await api('POST', '/auth/register', payload);
  assert.equal(first.status, 201);

  await pool.query(
    `UPDATE email_verification_codes
        SET created_at = now() - interval '3 minutes'
      WHERE user_id = $1`,
    [first.body.user.id]
  );

  const second = await api('POST', '/auth/register', payload);
  assert.equal(second.status, 409);
  assert.equal(second.body.needsVerification, true);
  assert.equal(second.body.email, address);
  assert.match(second.body.error, /verification/i);

  const count = await pool.query('SELECT COUNT(*)::int AS n FROM users WHERE lower(email) = $1', [address]);
  assert.equal(count.rows[0].n, 1, 'no duplicate account is created');

  const active = await pool.query(
    `SELECT code FROM email_verification_codes
      WHERE user_id = $1 AND used_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC`,
    [first.body.user.id]
  );
  assert.equal(active.rowCount, 1);
  assert.match(active.rows[0].code, /^\d{6}$/);
});
