// "Published by" on articles, against a REAL PostgreSQL.
//
// Every article on the live site was showing NO byline at all — nobody had
// filled in author_name and no contributor was linked, so the line rendered
// empty. The fix derives it, in SQL, so every route agrees on one rule and no
// front end reimplements the fallback:
//
//   1. a typed byline wins;
//   2. failing that, the name on the account that submitted it;
//   3. failing THAT, nothing — the line is left off rather than printing an
//      email address, a username, or a guess at who wrote it.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-byline-'));
const port = 35600 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

async function req(method, urlPath) {
  const res = await fetch(baseUrl + urlPath, { method });
  let json = null;
  try { json = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, body: json };
}

let _id = 1301000;
async function makeUser(fullName) {
  const id = _id++;
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role, full_name)
     VALUES ($1, $2, 'x', 'member', $3)`,
    [id, `by${id}@test.com`, fullName === undefined ? null : fullName]);
  return id;
}

async function makeArticle(userId, over = {}) {
  const r = await pool.query(
    `INSERT INTO articles (title, body, author_user_id, status, published_at, author_name)
     VALUES ($1, 'The story body.', $2, 'approved', now(), $3) RETURNING id`,
    [over.title || 'A Story', userId, over.authorName === undefined ? null : over.authorName]);
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
  process.env.JWT_SECRET = 'test-secret-for-byline';
  process.env.UNPLUG_DISABLE_RATE_LIMITS = '1';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }

  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/articles', require('../src/routes/articles'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
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

test('A TYPED BYLINE WINS', async () => {
  const uid = await makeUser('Account Holder Name');
  const id = await makeArticle(uid, { authorName: 'Thandi Mokoena' });

  const shown = await req('GET', `/articles/${id}`);
  assert.equal(shown.status, 200);
  const a = shown.body.article || shown.body;
  assert.equal(a.published_by, 'Thandi Mokoena',
    'what somebody actually typed beats a derived name');
});

test('WITH NO BYLINE, THE SUBMITTING ACCOUNT NAME IS USED', async () => {
  // This is the case that matters: it is what puts a line on the articles
  // that had none.
  const uid = await makeUser('Sipho Ndlovu');
  const id = await makeArticle(uid);

  const shown = await req('GET', `/articles/${id}`);
  const a = shown.body.article || shown.body;
  assert.equal(a.published_by, 'Sipho Ndlovu');
});

test('WITH NEITHER, THE LINE IS LEFT OFF — no email address, no guess', async () => {
  // An account with no name saved must not leak an email address onto a
  // public page, and inventing a byline would credit somebody who never
  // claimed the piece.
  const uid = await makeUser(null);
  const id = await makeArticle(uid);

  const shown = await req('GET', `/articles/${id}`);
  const a = shown.body.article || shown.body;
  assert.equal(a.published_by, null, 'nothing rather than something wrong');
});

test('a blank byline does not beat the fallback', async () => {
  // An empty string is not a byline. Without NULLIF it would win the COALESCE
  // and the line would render as "Published by " with nothing after it.
  const uid = await makeUser('Real Name Here');
  const id = await makeArticle(uid, { authorName: '   ' });

  const shown = await req('GET', `/articles/${id}`);
  const a = shown.body.article || shown.body;
  assert.equal(a.published_by, 'Real Name Here');
});

test('a blank account name does not produce an empty byline either', async () => {
  const uid = await makeUser('   ');
  const id = await makeArticle(uid);

  const shown = await req('GET', `/articles/${id}`);
  const a = shown.body.article || shown.body;
  assert.equal(a.published_by, null);
});

test('THE FEED CARRIES IT TOO, so cards and the article page agree', async () => {
  // Two places render a byline. If only one had the derived value they would
  // disagree about the same article.
  const uid = await makeUser('Feed Author');
  await makeArticle(uid, { title: 'Feed Byline Story' });

  const feed = await req('GET', '/articles?limit=100');
  assert.equal(feed.status, 200, `feed failed: ${JSON.stringify(feed.body)}`);
  const row = (feed.body.articles || []).find((x) => x.title === 'Feed Byline Story');
  assert.ok(row, 'the article is in the feed');
  assert.equal(row.published_by, 'Feed Author');
});

test('a typed byline is used even when the account has a different name', async () => {
  // Named for what it actually checks. The "deleted account" case cannot be
  // reached: author_user_id is ON DELETE CASCADE, so deleting the account
  // takes the article with it. The join is still a LEFT JOIN so a missing
  // user would only cost the byline, never drop the article from the feed.
  const uid = await makeUser('Temporary Person');
  const id = await makeArticle(uid, { title: 'Still Readable', authorName: 'Kept Byline' });

  const shown = await req('GET', `/articles/${id}`);
  assert.equal(shown.status, 200);
  assert.equal((shown.body.article || shown.body).published_by, 'Kept Byline');
});

test('the byline is public — a signed-out reader sees who published it', async () => {
  const uid = await makeUser('Public Byline');
  const id = await makeArticle(uid);
  const anon = await req('GET', `/articles/${id}`);
  assert.equal(anon.status, 200);
  assert.equal((anon.body.article || anon.body).published_by, 'Public Byline');
});
