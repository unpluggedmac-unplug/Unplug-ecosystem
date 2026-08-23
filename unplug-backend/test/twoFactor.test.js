// Two-factor authentication, against a REAL PostgreSQL.
//
// The failures that matter here are asymmetric. A second factor that is too
// weak costs an admin account; a second factor that is too eager locks the
// only people who can fix it out of their own site. So both directions are
// pinned:
//
//   1. IT MUST NOT LOCK ANYONE OUT. Enrolment is not finished until a code has
//      been proved, and recovery codes exist for the day the phone does not.
//   2. A CODE CANNOT BE REPLAYED. TOTP codes live thirty seconds; one seen
//      over a shoulder is usable until it expires.
//   3. THE PASSWORD IS CHECKED FIRST. Asking for a code before the password is
//      right would confirm the password to an attacker.
//   4. A STOLEN SESSION CANNOT SWITCH IT OFF.
//
// Run with:  npm test   (from unplug-backend/)

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const otplib = require('otplib');
const bcrypt = require('bcryptjs');
const EmbeddedPostgres = require('embedded-postgres').default;
const { stopPostgres } = require('./helpers/stopPostgres');

let pg;
let pool;
let tf;
let server;
let baseUrl;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-2fa-'));
const port = 38400 + (process.pid % 300); // bases are 400 apart so ranges cannot overlap

const ADMIN_ID = 441001;

async function login(email, password, twoFactorCode) {
  const res = await fetch(baseUrl + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, twoFactorCode }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
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
  process.env.JWT_SECRET = 'test-secret-for-2fa';
  process.env.UNPLUG_DISABLE_RATE_LIMITS = '1';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }
  tf = require('../src/utils/twoFactor');

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/auth', require('../src/routes/auth'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await pool.query(
    `INSERT INTO users (id, email, password_hash, role, email_verified)
     VALUES ($1, 'admin2fa@test.com', $2, 'admin', true)`,
    [ADMIN_ID, bcrypt.hashSync('right-password', 8)]);
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
// Enrolment
// ---------------------------------------------------------------------------

test('STARTING ENROLMENT DOES NOT YET CHANGE SIGNING IN', async () => {
  // The mistake that locks somebody out: switching the second factor on before
  // they have proved their app can produce a code for it.
  const { secret, uri } = await tf.beginEnrolment(ADMIN_ID, 'admin2fa@test.com');
  assert.ok(secret && secret.length >= 16);
  assert.match(uri, /^otpauth:\/\/totp\//);
  assert.match(uri, /issuer=Unplug/);

  assert.equal(await tf.isEnabled(ADMIN_ID), false, 'not on yet');
  const ok = await login('admin2fa@test.com', 'right-password');
  assert.equal(ok.status, 200, 'and signing in still works with the password alone');
});

test('a wrong code does not complete enrolment', async () => {
  const result = await tf.confirmEnrolment(ADMIN_ID, '000000');
  assert.equal(result.ok, false);
  assert.equal(await tf.isEnabled(ADMIN_ID), false);
});

test('A PROVED CODE SWITCHES IT ON AND HANDS BACK RECOVERY CODES', async () => {
  const r = await pool.query('SELECT two_factor_secret FROM users WHERE id = $1', [ADMIN_ID]);
  const secret = r.rows[0].two_factor_secret;

  const result = await tf.confirmEnrolment(ADMIN_ID, await otplib.generate({ secret }));
  assert.equal(result.ok, true);
  assert.equal(await tf.isEnabled(ADMIN_ID), true);
  assert.equal(result.recoveryCodes.length, tf.RECOVERY_CODE_COUNT);
  // Written down by hand, so no characters that can be misread.
  assert.ok(result.recoveryCodes.every((c) => !/[ILO01]/.test(c)),
    'no letters that look like digits on paper');
});

test('RECOVERY CODES ARE STORED HASHED, NEVER IN PLAIN TEXT', async () => {
  // A recovery code is a password by another name: one string that gets you
  // past the second factor. One read of this table must not be every admin's
  // way in.
  const rows = await pool.query(
    'SELECT code_hash FROM two_factor_recovery_codes WHERE user_id = $1', [ADMIN_ID]);
  assert.ok(rows.rowCount > 0);
  for (const row of rows.rows) {
    assert.match(row.code_hash, /^\$2[aby]\$/, 'a bcrypt hash, not the code');
  }
});

// ---------------------------------------------------------------------------
// Signing in
// ---------------------------------------------------------------------------

test('THE PASSWORD IS CHECKED BEFORE THE CODE IS ASKED FOR', async () => {
  // Otherwise the prompt confirms the password: an attacker who guessed
  // correctly would learn so from being asked for a code, and one who guessed
  // wrongly would not. That turns the feature into a password oracle.
  const wrong = await login('admin2fa@test.com', 'wrong-password');
  assert.equal(wrong.status, 401);
  assert.ok(!wrong.body.twoFactorRequired,
    'a wrong password is never told that a second factor exists');

  const right = await login('admin2fa@test.com', 'right-password');
  assert.equal(right.status, 401, 'the right password alone is not enough');
  assert.equal(right.body.twoFactorRequired, true);
});

// Every test below signs in within seconds of the last one, so they share a
// thirty-second TOTP window and would otherwise all present the same code.
// This clears the replay marker to stand for "a later sign-in", which is what
// actually happens in life. Where the replay guard itself is under test, the
// marker is deliberately left alone.
async function asIfLater() {
  await pool.query('UPDATE users SET two_factor_last_token = NULL WHERE id = $1', [ADMIN_ID]);
}

async function currentCode() {
  const r = await pool.query('SELECT two_factor_secret FROM users WHERE id = $1', [ADMIN_ID]);
  return otplib.generate({ secret: r.rows[0].two_factor_secret });
}

test('THE CODE USED TO ENROL CANNOT THEN BE USED TO SIGN IN', async () => {
  // Not a quirk — the correct behaviour, and worth pinning. That code has been
  // used once already, to prove the app worked. Somebody who saw it during
  // setup must not be able to sign in with it seconds later.
  const enrolmentCode = await currentCode();
  const res = await login('admin2fa@test.com', 'right-password', enrolmentCode);
  assert.equal(res.status, 401);
  assert.match(res.body.error, /already been used/i);
  assert.match(res.body.error, /next one/i, 'and says what to do about it');
});

test('the right password and the right code sign you in', async () => {
  await asIfLater();
  const res = await login('admin2fa@test.com', 'right-password', await currentCode());
  assert.equal(res.status, 200);
  assert.ok(res.body.token);
});

test('A CODE CANNOT BE USED TWICE', async () => {
  // TOTP codes last thirty seconds. One glimpsed over a shoulder, or captured
  // in a log, stays usable until it expires — unless the last accepted one is
  // remembered and refused. The marker is NOT cleared here; that is the point.
  await asIfLater();
  const code = await currentCode();

  const first = await login('admin2fa@test.com', 'right-password', code);
  assert.equal(first.status, 200);

  const second = await login('admin2fa@test.com', 'right-password', code);
  assert.equal(second.status, 401, 'the same code is refused the second time');
  assert.match(second.body.error, /already been used/i);
});

test('a wrong code is refused', async () => {
  const res = await login('admin2fa@test.com', 'right-password', '000000');
  assert.equal(res.status, 401);
  assert.equal(res.body.twoFactorRequired, true);
});

test('A RECOVERY CODE WORKS ONCE, AND ONLY ONCE', async () => {
  const codes = await tf.regenerateRecoveryCodes(ADMIN_ID);
  const code = codes[0];

  const first = await tf.verifySecondFactor(ADMIN_ID, code);
  assert.equal(first.ok, true);
  assert.equal(first.usedRecoveryCode, true);
  assert.equal(first.remainingRecoveryCodes, tf.RECOVERY_CODE_COUNT - 1);

  const second = await tf.verifySecondFactor(ADMIN_ID, code);
  assert.equal(second.ok, false, 'a used code is spent');
});

test('a recovery code is accepted however it was typed', async () => {
  // People read these off paper. Case and stray spaces must not matter.
  const codes = await tf.regenerateRecoveryCodes(ADMIN_ID);
  const messy = '  ' + codes[0].toLowerCase() + ' ';
  assert.equal((await tf.verifySecondFactor(ADMIN_ID, messy)).ok, true);
});

test('regenerating codes invalidates the previous set', async () => {
  const first = await tf.regenerateRecoveryCodes(ADMIN_ID);
  await tf.regenerateRecoveryCodes(ADMIN_ID);
  assert.equal((await tf.verifySecondFactor(ADMIN_ID, first[0])).ok, false,
    'an old code stops working, which is the point of regenerating');
});

// ---------------------------------------------------------------------------
// Turning it off
// ---------------------------------------------------------------------------

test('IT CANNOT BE SWITCHED OFF WITHOUT PASSING IT', async () => {
  // Otherwise anyone holding a stolen session simply removes the protection.
  const bad = await tf.disable(ADMIN_ID, '000000');
  assert.equal(bad.ok, false);
  assert.equal(await tf.isEnabled(ADMIN_ID), true, 'still on');
});

test('a correct code switches it off and clears everything behind it', async () => {
  await asIfLater();
  const result = await tf.disable(ADMIN_ID, await currentCode());
  assert.equal(result.ok, true);
  assert.equal(await tf.isEnabled(ADMIN_ID), false);

  const left = await pool.query(
    'SELECT count(*)::int AS n FROM two_factor_recovery_codes WHERE user_id = $1', [ADMIN_ID]);
  assert.equal(left.rows[0].n, 0, 'the recovery codes go with it');

  const secretRow = await pool.query('SELECT two_factor_secret FROM users WHERE id = $1', [ADMIN_ID]);
  assert.equal(secretRow.rows[0].two_factor_secret, null, 'and so does the secret');
});

test('with it off, the password alone signs you in again', async () => {
  const res = await login('admin2fa@test.com', 'right-password');
  assert.equal(res.status, 200);
});

test('an account without 2FA is completely unaffected', async () => {
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role, email_verified)
     VALUES (441002, 'plain@test.com', $1, 'member', true)`, [bcrypt.hashSync('pw', 8)]);
  const res = await login('plain@test.com', 'pw');
  assert.equal(res.status, 200, 'members are not asked for a code');
});
