// Consent records and the member data export, against a REAL PostgreSQL.
//
// What this protects:
//
//   1. THE EXPORT IS NEVER A WAY TO TAKE OVER AN ACCOUNT. It is a file the
//      member can hand to anybody, so sign-in tokens, verification codes,
//      two-factor recovery codes and the password hash must never be in it.
//   2. IT NEVER CONTAINS SOMEBODY ELSE'S DATA.
//   3. IT FINDS NEW TABLES BY ITSELF. The list is discovered from
//      information_schema rather than written down, because a hand-kept list
//      would be wrong within a month and an export that silently omits data is
//      worse than no export — it is offered as a complete answer.
//   4. A WITHDRAWAL IS A NEW ROW. The fact that somebody consented and later
//      changed their mind is the history the table exists to hold.
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
let meToken;
let otherToken;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-privacy-'));
const port = 44000 + (process.pid % 300); // bases are 400 apart so ranges cannot overlap

const migrationsDir = path.join(__dirname, '..', 'db', 'migrations');
async function runMigrations() {
  for (const f of fs.readdirSync(migrationsDir).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(migrationsDir, f), 'utf8'));
  }
}

async function api(method, urlPath, body, token) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const ME = 580001;
const OTHER = 580002;
const SECRET_PASSWORD_HASH = '$2b$10$zzzzzzzzzzzzzzzzzzzzzzTHISISTHEHASHzzzzzzzzzzzzzzzzzz';
const OTHERS_TITLE = 'AN ARTICLE BELONGING TO SOMEBODY ELSE';

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
  process.env.JWT_SECRET = 'test-secret-for-privacy';
  process.env.UNPLUG_DISABLE_RATE_LIMITS = '1';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await runMigrations();

  const jwt = require('jsonwebtoken');
  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/privacy', require('../src/routes/privacy'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await pool.query(
    `INSERT INTO users (id, email, full_name, password_hash, role, phone) VALUES
       ($1, 'me@test.com', 'Me Myself', $3, 'member', '082 000 1111'),
       ($2, 'other@test.com', 'Someone Else', 'other-hash', 'member', '082 000 2222')`,
    [ME, OTHER, SECRET_PASSWORD_HASH]
  );
  const sign = (id, email) => jwt.sign({ id, email, role: 'member' }, process.env.JWT_SECRET);
  meToken = sign(ME, 'me@test.com');
  otherToken = sign(OTHER, 'other@test.com');

  await pool.query(`INSERT INTO categories (id, name, type) VALUES (9701, 'News', 'news')
                    ON CONFLICT (id) DO NOTHING`);
  await pool.query(
    `INSERT INTO articles (author_user_id, category_id, title, body, status)
     VALUES ($1, 9701, 'My Own Article', 'Mine.', 'approved'),
            ($2, 9701, $3, 'Theirs.', 'approved')`,
    [ME, OTHER, OTHERS_TITLE]
  );

  // Live credentials that must never leave the building.
  await pool.query(
    `INSERT INTO password_reset_tokens (user_id, token, expires_at)
     VALUES ($1, 'RESET-TOKEN-DO-NOT-LEAK', now() + interval '1 hour')`, [ME]);
  await pool.query(
    `INSERT INTO email_verification_codes (user_id, code, expires_at)
     VALUES ($1, '424242', now() + interval '1 hour')`, [ME]);
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
});

// ----------------------------------------------------------------- consent

test('a consent decision is recorded against the policy version it was given for', async () => {
  const { status, body } = await api('POST', '/privacy/consent', { choice: 'accepted', visitorKey: 'abc123' });
  assert.equal(status, 201);
  assert.ok(body.policyVersion, 'the version is reported back');

  const r = await pool.query(
    `SELECT choice, policy_version, visitor_key FROM consent_records ORDER BY id DESC LIMIT 1`);
  assert.equal(r.rows[0].choice, 'accepted');
  assert.equal(r.rows[0].visitor_key, 'abc123');
  assert.ok(r.rows[0].policy_version, 'and stored — without it the record proves nothing once the policy is reworded');
});

test('A WITHDRAWAL IS A NEW ROW, NOT AN EDIT', async () => {
  const before = (await pool.query('SELECT COUNT(*)::int n FROM consent_records')).rows[0].n;
  await api('POST', '/privacy/consent', { choice: 'declined', visitorKey: 'abc123' });
  const after = (await pool.query('SELECT COUNT(*)::int n FROM consent_records')).rows[0].n;
  assert.equal(after, before + 1, 'changing your mind is history, not a correction');

  const both = await pool.query(
    `SELECT choice FROM consent_records WHERE visitor_key = 'abc123' ORDER BY id`);
  assert.deepEqual(both.rows.map((x) => x.choice), ['accepted', 'declined']);
});

test('a signed-in decision is tied to the account', async () => {
  await api('POST', '/privacy/consent', { choice: 'accepted' }, meToken);
  const r = await pool.query(
    `SELECT user_id FROM consent_records WHERE user_id = $1`, [ME]);
  assert.ok(r.rows.length > 0);
});

test('an invented choice is refused', async () => {
  for (const choice of ['maybe', '', null, 'ACCEPTED ']) {
    const { status } = await api('POST', '/privacy/consent', { choice });
    assert.equal(status, 400, JSON.stringify(choice) + ' must be refused');
  }
});

test('NO IP ADDRESS IS STORED', async () => {
  // Storing an IP to prove consent to anonymous analytics would collect more
  // about the person than the thing being consented to.
  const cols = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'consent_records'`);
  const names = cols.rows.map((c) => c.column_name);
  assert.ok(!names.some((n) => /ip/i.test(n)), 'no ip column: ' + names.join(', '));
});

// ------------------------------------------------------------------ export

test('the export needs a signed-in account', async () => {
  const { status } = await api('GET', '/privacy/export');
  assert.equal(status, 401);
});

test('it contains the member\'s own account and content', async () => {
  const { status, body } = await api('GET', '/privacy/export', null, meToken);
  assert.equal(status, 200);
  assert.equal(body.account.email, 'me@test.com');
  assert.equal(body.account.phone, '082 000 1111');
  assert.ok(body.data.articles, 'their articles are in it');
  assert.ok(body.data.articles.some((a) => a.title === 'My Own Article'));
  assert.ok(Array.isArray(body.consentHistory));
});

test('THE EXPORT IS NEVER A WAY TO TAKE OVER THE ACCOUNT', async () => {
  const { body } = await api('GET', '/privacy/export', null, meToken);
  const dump = JSON.stringify(body);
  assert.equal(body.account.password_hash, undefined, 'no password hash');
  assert.equal(dump.indexOf(SECRET_PASSWORD_HASH), -1, 'and not anywhere else either');
  assert.equal(dump.indexOf('RESET-TOKEN-DO-NOT-LEAK'), -1, 'no live password-reset token');
  assert.equal(dump.indexOf('424242'), -1, 'no live verification code');
  assert.equal(body.data.password_reset_tokens, undefined);
  assert.equal(body.data.email_verification_codes, undefined);
  assert.equal(body.data.two_factor_recovery_codes, undefined);
  assert.equal(body.data.magic_link_tokens, undefined);
});

test('IT NEVER CONTAINS SOMEBODY ELSE\'S DATA', async () => {
  const { body } = await api('GET', '/privacy/export', null, meToken);
  assert.equal(JSON.stringify(body).indexOf(OTHERS_TITLE), -1);
  assert.equal(JSON.stringify(body).indexOf('other@test.com'), -1);

  // And the other way round, so this is not passing by accident.
  const theirs = await api('GET', '/privacy/export', null, otherToken);
  assert.ok(theirs.body.data.articles.some((a) => a.title === OTHERS_TITLE));
  assert.equal(JSON.stringify(theirs.body).indexOf('My Own Article'), -1);
});

test('the anonymous analytics are left out', async () => {
  // They were deliberately never linked to a person; putting them in an export
  // keyed to that person would rebuild the browsing history we avoided keeping.
  const { body } = await api('GET', '/privacy/export', null, meToken);
  for (const t of ['analytics_events', 'analytics_sessions', 'page_views', 'content_views']) {
    assert.equal(body.data[t], undefined, t + ' must not be exported');
  }
});

test('IT FINDS A NEW TABLE BY ITSELF', async () => {
  // The whole point of discovering the list instead of writing it down: a
  // feature added next month that stores something against a member appears in
  // the export without anybody remembering to add it.
  await pool.query(`CREATE TABLE IF NOT EXISTS a_brand_new_feature (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    note TEXT)`);
  await pool.query(`INSERT INTO a_brand_new_feature (user_id, note) VALUES ($1, 'invented later')`, [ME]);

  const { body } = await api('GET', '/privacy/export', null, meToken);
  assert.ok(body.data.a_brand_new_feature, 'a table nobody listed still turns up');
  assert.equal(body.data.a_brand_new_feature[0].note, 'invented later');

  await pool.query('DROP TABLE a_brand_new_feature');
});

test('a very large section is capped and says so', async () => {
  const cap = 1000;
  await pool.query(`CREATE TABLE IF NOT EXISTS a_big_feature (
    id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id), n INTEGER)`);
  await pool.query(
    `INSERT INTO a_big_feature (user_id, n) SELECT $1, g FROM generate_series(1, $2) g`, [ME, cap + 50]);

  const { body } = await api('GET', '/privacy/export', null, meToken);
  assert.equal(body.data.a_big_feature.length, cap, 'capped so one member cannot exhaust the instance');
  assert.ok(body.notes.truncatedSections.includes('a_big_feature'), 'and the file admits it was cut');

  await pool.query('DROP TABLE a_big_feature');
});

test('the file explains what it deliberately leaves out', async () => {
  const { body } = await api('GET', '/privacy/export', null, meToken);
  assert.match(body.notes.excluded, /token|code/i,
    'somebody reading the file should not have to ask why it is not everything');
});

test('re-running every migration is idempotent and keeps the records', async () => {
  const before = (await pool.query('SELECT COUNT(*)::int n FROM consent_records')).rows[0].n;
  assert.ok(before > 0);
  await runMigrations();
  const after = (await pool.query('SELECT COUNT(*)::int n FROM consent_records')).rows[0].n;
  assert.equal(after, before, 'a re-run must not clear the consent history');
});
