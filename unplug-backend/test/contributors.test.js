// CONTRIBUTORS AND BYLINES — who wrote this.
//
// Articles had no author at all: the only name was `kicker_supplied_by`, whose
// field is labelled "Supplied by", so the reader page said "Submitted by ..."
// over journalism nobody had been credited for. The guarantees worth pinning:
//
//   1. WHO WROTE IT and WHO SENT IT IN stay two separate facts. Merging them
//      would misattribute a real person's work, which is worse than the
//      original wording.
//   2. A member submitting an article can set the byline themselves — that
//      path was the explicit ask, and it is the one place the writer's name is
//      actually known at the time.
//   3. A member CANNOT link their article to a contributor profile. That is an
//      editorial act: it puts a piece on someone else's public page.
//   4. Deleting a contributor never deletes or unbylines their published work.
//   5. A contributor page never exposes drafts or future-dated articles.
//
// Over real HTTP against real PostgreSQL. See universalComments.test.js for
// why require('../src/app') is avoided.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-contrib-'));
const port = 28000 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

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
  return jwt.sign({ id: userId, email: `cb${userId}@test.com`, role }, process.env.JWT_SECRET);
}

let _nextUserId = 201000;
async function makeUser(role = 'member') {
  const id = _nextUserId++;
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', $3)
     ON CONFLICT DO NOTHING`,
    [id, `cb${id}@test.com`, role]
  );
  return id;
}

let adminToken;
let adminId;
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
  process.env.JWT_SECRET = 'test-secret-for-contributors';
  process.env.UNPLUG_DISABLE_RATE_LIMITS = '1';

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
  app.use('/contributors', require('../src/routes/contributors'));
  app.use('/articles', require('../src/routes/articles'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  adminId = await makeUser('admin');
  adminToken = tokenFor(adminId, 'admin');
  memberId = await makeUser('member');
  memberToken = tokenFor(memberId, 'member');
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
// The two facts stay separate
// ---------------------------------------------------------------------------

test('a member submitting an article can set the byline themselves', async () => {
  const res = await req('POST', '/articles', {
    token: memberToken,
    body: {
      title: 'A Story With An Author',
      body: 'A piece long enough to be a real article about small businesses in Limpopo.',
      authorName: 'Thandi Mokoena',
    },
  });
  assert.equal(res.status, 201);

  const row = await pool.query('SELECT author_name FROM articles WHERE id = $1', [res.body.article.id]);
  assert.equal(row.rows[0].author_name, 'Thandi Mokoena',
    'the submission path must carry the byline — it is where the writer is actually known');
});

test('WHO WROTE IT and WHO SENT IT IN are stored separately', async () => {
  const res = await req('POST', '/articles', {
    token: memberToken,
    body: {
      title: 'Written By One, Sent By Another',
      body: 'A piece supplied by a business but written by somebody else entirely.',
      authorName: 'Thandi Mokoena',
      kickerSuppliedBy: 'Cape Town Chamber',
    },
  });
  assert.equal(res.status, 201);

  const row = await pool.query(
    'SELECT author_name, kicker_supplied_by FROM articles WHERE id = $1', [res.body.article.id]
  );
  assert.equal(row.rows[0].author_name, 'Thandi Mokoena');
  assert.equal(row.rows[0].kicker_supplied_by, 'Cape Town Chamber',
    'merging these two would credit the wrong party for the writing');
});

test('an article with no byline is still allowed', async () => {
  // Most existing articles have none. Requiring one would break every edit.
  const res = await req('POST', '/articles', {
    token: memberToken,
    body: { title: 'No Byline Here', body: 'A perfectly ordinary article with nobody credited yet.' },
  });
  assert.equal(res.status, 201);
  const row = await pool.query('SELECT author_name FROM articles WHERE id = $1', [res.body.article.id]);
  assert.equal(row.rows[0].author_name, null);
});

// ---------------------------------------------------------------------------
// Contributor profiles
// ---------------------------------------------------------------------------

let contributorId;
let contributorSlug;

test('an admin can add a contributor, and the slug is derived', async () => {
  const res = await req('POST', '/contributors/admin', {
    token: adminToken,
    body: { name: 'Thandi Mokoena', roleTitle: 'Senior Writer', bio: 'Writes about small business.' },
  });
  assert.equal(res.status, 201);
  contributorId = res.body.contributor.id;
  contributorSlug = res.body.contributor.slug;
  assert.equal(contributorSlug, 'thandi-mokoena');
});

test('two contributors with the same name get different pages', async () => {
  const res = await req('POST', '/contributors/admin', {
    token: adminToken, body: { name: 'Thandi Mokoena' },
  });
  assert.equal(res.status, 201);
  assert.notEqual(res.body.contributor.slug, contributorSlug,
    'a duplicate slug would mean one writer page silently showing the other writer');
});

test('only an admin may link an article to a contributor', async () => {
  const created = await req('POST', '/articles', {
    token: memberToken,
    body: { title: 'Member Tries To Link', body: 'A member submitting an article about anything at all.' },
  });
  const id = created.body.article.id;

  // A member editing their own article may set the byline text...
  const asMember = await req('PATCH', `/articles/${id}`, {
    token: memberToken, body: { authorName: 'Themselves', contributorId },
  });
  assert.equal(asMember.status, 200);

  const row = await pool.query('SELECT author_name, contributor_id FROM articles WHERE id = $1', [id]);
  assert.equal(row.rows[0].author_name, 'Themselves', 'the byline text is theirs to set');
  assert.equal(row.rows[0].contributor_id, null,
    'BUT LINKING TO A CONTRIBUTOR PROFILE IS EDITORIAL — it would put their piece on someone else\'s public page');
});

test('an admin can link an article, and the byline then carries the page', async () => {
  const created = await req('POST', '/articles', {
    token: adminToken,
    body: { title: 'Properly Credited', body: 'An article written by a real contributor with a profile.' },
  });
  const id = created.body.article.id;

  const linked = await req('PATCH', `/articles/${id}`, {
    token: adminToken, body: { contributorId, authorName: 'Thandi Mokoena' },
  });
  assert.equal(linked.status, 200);

  const read = await req('GET', `/articles/${id}`);
  assert.equal(read.body.article.contributor_name, 'Thandi Mokoena');
  assert.equal(read.body.article.contributor_slug, contributorSlug,
    'the reader page needs the slug to turn the byline into a link');
});

test('the contributor page lists their published work', async () => {
  const res = await req('GET', `/contributors/${contributorSlug}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.contributor.name, 'Thandi Mokoena');
  assert.equal(res.body.contributor.role_title, 'Senior Writer');
  assert.ok(res.body.articles.some((a) => a.title === 'Properly Credited'));
});

test('a contributor page NEVER shows a draft or a future-dated article', async () => {
  // This is a public page. A piece held back for a reason must not be
  // reachable through the writer's page when it is not reachable anywhere else.
  const draft = await req('POST', '/articles', {
    token: adminToken, body: { title: 'Secret Draft', body: 'Not ready for anyone to read yet at all.' },
  });
  await pool.query(
    `UPDATE articles SET status = 'draft', contributor_id = $1 WHERE id = $2`,
    [contributorId, draft.body.article.id]
  );

  const future = await req('POST', '/articles', {
    token: adminToken, body: { title: 'Embargoed Piece', body: 'Scheduled for a date that has not arrived.' },
  });
  await pool.query(
    `UPDATE articles SET status = 'approved', scheduled_for = CURRENT_DATE + 30, contributor_id = $1 WHERE id = $2`,
    [contributorId, future.body.article.id]
  );

  const res = await req('GET', `/contributors/${contributorSlug}`);
  const titles = res.body.articles.map((a) => a.title);
  assert.ok(!titles.includes('Secret Draft'), 'a draft must not leak through the contributor page');
  assert.ok(!titles.includes('Embargoed Piece'), 'a future-dated article must not leak either');
});

test('the public contributor page never exposes an email address', async () => {
  await req('PATCH', `/contributors/admin/${contributorId}`, {
    token: adminToken, body: { email: 'thandi@example.com' },
  });
  const res = await req('GET', `/contributors/${contributorSlug}`);
  assert.equal(res.body.contributor.email, undefined,
    'a public page carrying a personal email address is an invitation to spam');
  assert.equal(res.body.contributor.user_id, undefined);
});

test('a hidden contributor drops off the list and their page 404s', async () => {
  await req('PATCH', `/contributors/admin/${contributorId}`, {
    token: adminToken, body: { isActive: false },
  });
  const list = await req('GET', '/contributors');
  assert.ok(!list.body.contributors.some((c) => c.id === contributorId));
  assert.equal((await req('GET', `/contributors/${contributorSlug}`)).status, 404);

  await req('PATCH', `/contributors/admin/${contributorId}`, {
    token: adminToken, body: { isActive: true },
  });
});

test('DELETING A CONTRIBUTOR NEVER DELETES THEIR ARTICLES', async () => {
  // The refusal exists so nobody discovers the alternative the hard way.
  const res = await req('DELETE', `/contributors/admin/${contributorId}`, { token: adminToken });
  assert.equal(res.status, 409, 'deleting a credited contributor must be refused');
  assert.match(res.body.error, /Deactivate them instead/);
  assert.ok(res.body.articleCount > 0);

  const still = await pool.query(
    'SELECT COUNT(*)::int AS n FROM articles WHERE contributor_id = $1', [contributorId]
  );
  assert.ok(still.rows[0].n > 0, 'their articles must be untouched');
});

test('an uncredited contributor can be deleted', async () => {
  const made = await req('POST', '/contributors/admin', {
    token: adminToken, body: { name: 'Added By Mistake' },
  });
  const res = await req('DELETE', `/contributors/admin/${made.body.contributor.id}`, { token: adminToken });
  assert.equal(res.status, 200);
});

test('even a forced delete leaves the article standing', async () => {
  // ON DELETE SET NULL, not CASCADE. If this ever became CASCADE, removing one
  // person from a list would silently delete years of published work.
  const made = await req('POST', '/contributors/admin', {
    token: adminToken, body: { name: 'Temporary Person' },
  });
  const cid = made.body.contributor.id;
  const art = await req('POST', '/articles', {
    token: adminToken, body: { title: 'Survives Its Author', body: 'An article whose contributor row is about to vanish.' },
  });
  await pool.query('UPDATE articles SET contributor_id = $1 WHERE id = $2', [cid, art.body.article.id]);

  await pool.query('DELETE FROM contributors WHERE id = $1', [cid]);

  const row = await pool.query(
    'SELECT id, author_name, contributor_id FROM articles WHERE id = $1', [art.body.article.id]
  );
  assert.equal(row.rows.length, 1, 'THE ARTICLE MUST SURVIVE');
  assert.equal(row.rows[0].contributor_id, null, 'it simply stops linking to a page');
});

test('contributor admin routes are admin-only', async () => {
  assert.equal((await req('GET', '/contributors/admin/all')).status, 401);
  assert.equal((await req('GET', '/contributors/admin/all', { token: memberToken })).status, 403);
  assert.equal((await req('POST', '/contributors/admin', { token: memberToken, body: { name: 'X' } })).status, 403);
  assert.equal((await req('DELETE', '/contributors/admin/1', { token: memberToken })).status, 403);
});

test('the public list is readable without signing in', async () => {
  const res = await req('GET', '/contributors');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.contributors));
});

test('a contributor with no name is refused', async () => {
  const res = await req('POST', '/contributors/admin', { token: adminToken, body: { name: '   ' } });
  assert.equal(res.status, 400);
});

test('re-running every migration is idempotent', async () => {
  const before = await pool.query('SELECT COUNT(*)::int AS n FROM contributors');
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }
  const after = await pool.query('SELECT COUNT(*)::int AS n FROM contributors');
  assert.equal(after.rows[0].n, before.rows[0].n, 'a re-deploy must not disturb contributors');
});
