// Per-account brute-force backoff, against a REAL PostgreSQL.
//
// What this must get right, and what each mistake would cost:
//
//   1. IT MUST NOT LOCK ANYONE OUT PERMANENTLY. A hard lockout is a denial of
//      service that anyone can trigger against anyone whose email they know.
//      The delay has a ceiling and clears itself.
//   2. IT MUST NOT REVEAL WHICH ACCOUNTS EXIST. A failure against an unknown
//      address has to behave exactly like a failure against a real one — the
//      shared "invalid email or password" is pointless if the DELAY answers
//      the question instead.
//   3. A CORRECT PASSWORD MUST CLEAR IT. Otherwise a person who forgot their
//      password once is slowed down for the rest of the day.
//   4. IT MUST ACTUALLY STOP GUESSING. The delay has to grow fast enough that
//      a thousand attempts is not worth starting.
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
let attempts;
let server;
let baseUrl;
let bcrypt;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-bf-'));
const port = 37200 + (process.pid % 300); // bases are 400 apart so ranges cannot overlap

before(async () => {
  pg = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'postgres', password: 'postgres', port,
    persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('unplug_test');

  process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${port}/unplug_test`;
  process.env.JWT_SECRET = 'test-secret-for-bruteforce';
  // Explicitly NOT disabling rate limits: this file is testing them.
  delete process.env.UNPLUG_DISABLE_RATE_LIMITS;

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }
  attempts = require('../src/utils/loginAttempts');

  // The real auth router, so the wiring is tested and not just the helper.
  // Three call sites had to go in the right places; getting any of them wrong
  // would wrongly refuse real people, which is worse than the attack.
  bcrypt = require('bcryptjs');
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/auth', require('../src/routes/auth'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await pool.query(
    `INSERT INTO users (id, email, password_hash, role, email_verified)
     VALUES (661001, 'real@example.com', $1, 'member', true)`,
    [bcrypt.hashSync('correct-horse', 8)]);
});

async function login(email, password) {
  const res = await fetch(baseUrl + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
}

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  // Windows can still hold a handle on the data directory when Postgres exits.
  try { if (pg) await pg.stop(); } catch (e) { /* the OS being slow to let go */ }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* as above */ }
});

// ---------------------------------------------------------------------------
// The shape of the delay
// ---------------------------------------------------------------------------

test('the first few attempts are not delayed at all', async () => {
  // Somebody mistyping their own password must not be punished for it.
  for (let i = 1; i <= attempts.FREE_ATTEMPTS; i++) {
    assert.equal(attempts.delayFor(i), 0, `attempt ${i} is free`);
  }
});

test('THE DELAY DOUBLES, AND THEN STOPS DOUBLING', async () => {
  const fourth = attempts.delayFor(attempts.FREE_ATTEMPTS + 1);
  const fifth = attempts.delayFor(attempts.FREE_ATTEMPTS + 2);
  const sixth = attempts.delayFor(attempts.FREE_ATTEMPTS + 3);
  assert.equal(fourth, attempts.BASE_DELAY_SECONDS);
  assert.equal(fifth, fourth * 2);
  assert.equal(sixth, fifth * 2);

  // The ceiling matters as much as the growth: without it the delay becomes a
  // permanent lockout, which is the thing being avoided.
  assert.equal(attempts.delayFor(500), attempts.MAX_DELAY_SECONDS);
  assert.ok(Number.isFinite(attempts.delayFor(1000)), 'no overflow at absurd counts');
});

test('GUESSING BECOMES POINTLESS WITHIN A HANDFUL OF TRIES', async () => {
  // The reason this exists. By the tenth attempt an attacker should be waiting
  // minutes, not seconds, for each guess.
  assert.ok(attempts.delayFor(10) >= 300,
    `by the tenth attempt the wait is ${attempts.delayFor(10)}s`);
});

// ---------------------------------------------------------------------------
// Behaviour against the database
// ---------------------------------------------------------------------------

test('a fresh address is allowed straight through', async () => {
  const gate = await attempts.check('nobody@example.com');
  assert.equal(gate.allowed, true);
  assert.equal(gate.retryAfterSeconds, 0);
});

test('REPEATED FAILURES EVENTUALLY REFUSE THE ATTEMPT', async () => {
  const who = 'target@example.com';
  for (let i = 0; i < attempts.FREE_ATTEMPTS; i++) {
    await attempts.recordFailure(who, '10.0.0.1');
    assert.equal((await attempts.check(who)).allowed, true, `still free after ${i + 1}`);
  }
  const after = await attempts.recordFailure(who, '10.0.0.1');
  assert.ok(after.retryAfterSeconds > 0, 'the next one carries a wait');

  const gate = await attempts.check(who);
  assert.equal(gate.allowed, false);
  assert.ok(gate.retryAfterSeconds > 0);
});

test('A CORRECT PASSWORD WIPES THE RECORD', async () => {
  const who = 'forgetful@example.com';
  for (let i = 0; i < 6; i++) await attempts.recordFailure(who, '10.0.0.2');
  assert.equal((await attempts.check(who)).allowed, false);

  await attempts.recordSuccess(who);

  const gate = await attempts.check(who);
  assert.equal(gate.allowed, true, 'the owner arrived; the failures stop counting');
  assert.equal(gate.failedCount, 0);
});

test('AN UNKNOWN ADDRESS IS TREATED EXACTLY LIKE A REAL ONE', async () => {
  // If only real accounts were counted, the delay would answer the question
  // the shared error message refuses to answer: does this address exist here?
  const real = 'exists@example.com';
  const fake = 'does-not-exist@example.com';
  for (let i = 0; i < 5; i++) {
    await attempts.recordFailure(real, '10.0.0.3');
    await attempts.recordFailure(fake, '10.0.0.3');
  }
  const a = await attempts.check(real);
  const b = await attempts.check(fake);
  assert.equal(a.allowed, b.allowed, 'both refused');
  assert.equal(a.failedCount, b.failedCount, 'and by the same amount');
});

test('the address is matched however it was capitalised', async () => {
  // Otherwise "Victim@example.com" and "victim@example.com" are two separate
  // budgets and the whole thing is bypassed with a shift key.
  const who = 'MiXeD@Example.COM';
  for (let i = 0; i < 6; i++) await attempts.recordFailure(who, '10.0.0.4');
  assert.equal((await attempts.check('mixed@example.com')).allowed, false);
  assert.equal((await attempts.check('MIXED@EXAMPLE.COM')).allowed, false);
});

test('MANY ADDRESSES AGAINST ONE ACCOUNT IS COUNTED SEPARATELY', async () => {
  // One address failing repeatedly is a forgotten password. Many addresses
  // against one account is spraying, and the admin screen sorts on exactly
  // this to tell them apart.
  const who = 'sprayed@example.com';
  for (let i = 0; i < 8; i++) await attempts.recordFailure(who, `192.168.1.${i}`);

  const row = (await pool.query('SELECT distinct_ips, failed_count FROM login_attempts WHERE identifier = $1', [who])).rows[0];
  assert.equal(row.failed_count, 8);
  assert.ok(row.distinct_ips >= 7, `saw ${row.distinct_ips} different addresses`);
});

test('one address failing repeatedly is not mistaken for a spray', async () => {
  const who = 'justforgot@example.com';
  for (let i = 0; i < 8; i++) await attempts.recordFailure(who, '10.0.0.9');
  const row = (await pool.query('SELECT distinct_ips FROM login_attempts WHERE identifier = $1', [who])).rows[0];
  assert.equal(row.distinct_ips, 1);
});

test('a day of quiet clears the count on its own', async () => {
  const who = 'lastweek@example.com';
  for (let i = 0; i < 8; i++) await attempts.recordFailure(who, '10.0.0.5');
  assert.equal((await attempts.check(who)).allowed, false);

  await pool.query(
    `UPDATE login_attempts
        SET last_failed_at = now() - INTERVAL '2 days', blocked_until = now() - INTERVAL '1 day'
      WHERE identifier = $1`, [who]);

  const gate = await attempts.check(who);
  assert.equal(gate.allowed, true, 'somebody who failed last week is not mid-attack today');
  assert.equal(gate.failedCount, 0);
});

test('an admin can clear a delay for someone who is on the phone', async () => {
  const who = 'stuck@example.com';
  for (let i = 0; i < 8; i++) await attempts.recordFailure(who, '10.0.0.6');
  assert.equal((await attempts.check(who)).allowed, false);

  assert.equal(await attempts.clear(who), true);
  assert.equal((await attempts.check(who)).allowed, true);
  assert.equal(await attempts.clear('never-seen@example.com'), false);
});

test('the admin list puts the sprayed accounts first', async () => {
  const rows = await attempts.currentlyBlocked(20);
  assert.ok(rows.length > 0);
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i - 1].distinct_ips >= rows[i].distinct_ips,
      'ordered by how many different addresses have tried');
  }
  assert.ok(rows.some((r) => r.identifier === 'sprayed@example.com'));
});

test('concurrent failures cannot both write the same count', async () => {
  // Two attempts landing together must not each read "2" and each write "3".
  // The count is computed in SQL from its own previous value for this reason.
  const who = 'racy@example.com';
  await Promise.all(Array.from({ length: 10 }, (_, i) => attempts.recordFailure(who, `172.16.0.${i}`)));
  const row = (await pool.query('SELECT failed_count FROM login_attempts WHERE identifier = $1', [who])).rows[0];
  assert.equal(row.failed_count, 10, 'every one of the ten was counted');
});

test('a blank identifier is ignored rather than creating a row', async () => {
  await attempts.recordFailure('', '10.0.0.7');
  await attempts.recordFailure(null, '10.0.0.7');
  const r = await pool.query(`SELECT count(*)::int AS n FROM login_attempts WHERE identifier = ''`);
  assert.equal(r.rows[0].n, 0);
});

// ---------------------------------------------------------------------------
// The route itself
// ---------------------------------------------------------------------------
//
// THESE TESTS SPEND A SHARED BUDGET. loginLimiter also guards this route and
// allows ten attempts per IP per fifteen minutes; every request here comes from
// 127.0.0.1, so they draw on one allowance. An early draft made eleven requests
// and the last one came back 429 from the IP limiter, which looked exactly like
// the per-account backoff working and would have "passed" for the wrong reason.
//
// So failures are seeded through the helper, and HTTP is used only for the
// assertion itself. Fewer requests, and each test proves the thing it names.

test('THE LOGIN ROUTE REFUSES WITH 429 AND SAYS HOW LONG TO WAIT', async () => {
  const who = 'routed@example.com';
  for (let i = 0; i <= attempts.FREE_ATTEMPTS; i++) {
    await attempts.recordFailure(who, '203.0.113.5');
  }

  const res = await login(who, 'wrong');

  assert.equal(res.status, 429, 'not 401 — this is a rate decision, not a credentials one');
  assert.ok(res.headers.get('retry-after'), 'Retry-After is set so a client can behave properly');
  // These two also prove it is OUR message and not the IP limiter's, which
  // says "try again in 15 minutes" and mentions neither.
  assert.match(res.body.error, /wait/i);
  assert.match(res.body.error, /reset your password/i,
    'it points at the way out, so a real person is never simply stuck');
  assert.ok(res.body.retryAfterSeconds > 0);
});

test('A CORRECT PASSWORD STILL WORKS AFTER A FEW MISSES', async () => {
  // The failure that would matter most: somebody mistypes twice, gets it
  // right, and is refused anyway.
  await attempts.recordFailure('real@example.com', '203.0.113.6');
  await attempts.recordFailure('real@example.com', '203.0.113.6');

  const ok = await login('real@example.com', 'correct-horse');
  assert.equal(ok.status, 200, 'the right password is accepted');
  assert.ok(ok.body.token);

  // recordSuccess is fired without awaiting on the response path, so give it
  // a moment before checking that the slate was wiped.
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await attempts.check('real@example.com')).failedCount, 0,
    'and the successful sign-in cleared the record');
});

test('a wrong password on an unknown address answers exactly like a known one', async () => {
  // Same status and same body. The delay is covered above; this is the part a
  // person probing for valid addresses would actually read.
  const unknown = await login('ghost@example.com', 'wrong');
  const known = await login('real@example.com', 'wrong');
  assert.equal(unknown.status, 401);
  assert.equal(known.status, 401);
  assert.deepEqual(unknown.body, known.body);
});
