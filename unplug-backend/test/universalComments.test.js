// Members, Profile Social Interaction & Community System — Phase 2:
// Comments generalised to every content type, over real HTTP against
// real PostgreSQL (comments.js is exercised through Express, matching
// the existing pattern for other route-level test files in this repo,
// e.g. adminOverview.test.js).
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-ucomments-'));
const port = 16400 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

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

let _nextUserId = 15000;
async function makeUser(role = 'member') {
  const id = _nextUserId++;
  await pool.query(`INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', $3) ON CONFLICT DO NOTHING`, [id, `ucomment${id}@test.com`, role]);
  return id;
}

let jwt;
function tokenFor(userId, role = 'member') {
  return jwt.sign({ id: userId, email: `ucomment${userId}@test.com`, role }, process.env.JWT_SECRET);
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
  process.env.JWT_SECRET = 'test-secret-for-ucomments';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }

  jwt = require('jsonwebtoken');

  // Mounts only comments.js on a bare Express app, same pattern as
  // adminOverview.test.js — NOT require('../src/app'), which calls
  // app.listen() and starts the participation scheduler's setInterval
  // timers unconditionally at module load (no require.main guard). That
  // leaves a real server listening on port 4000 and timers that never
  // clear, hanging this file's child process (and so the whole `node
  // --test` run) well past this test file's own after() cleanup —
  // confirmed by reproducing the hang and finding the orphaned listener
  // with netstat before switching to this minimal-app pattern.
  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/comments', require('../src/routes/comments'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await pool.end();
  // stopPostgres, not pg.stop() directly: on Windows the library's stop
  // can HANG rather than throw, which used to leave the cluster running
  // with no parent and eventually broke a later test file's startup.
  // See test/helpers/stopPostgres.js.
  await stopPostgres(pg, dataDir);
});

let _nextArticleId = 0;
async function makeArticle(authorId) {
  const result = await pool.query(
    `INSERT INTO articles (author_user_id, title, body, status) VALUES ($1, $2, 'body', 'approved') RETURNING id`,
    [authorId, `Comment Test Article ${_nextArticleId++}`]
  );
  return result.rows[0].id;
}

test('article_comments no longer exists — Phase 2 consolidated it into content_comments', async () => {
  const result = await pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_name = 'article_comments'`
  );
  assert.equal(result.rows.length, 0);
});

test('a comment can be posted against a gallery image, not just an article — comments are no longer article-only', async () => {
  const author = await makeUser();
  const commenter = await makeUser();
  await pool.query(
    `INSERT INTO gallery_images (owner_type, owner_id, image_url, status) VALUES ('general', $1, 'x.jpg', 'approved')`,
    [author]
  );
  const gallery = await pool.query(`SELECT id FROM gallery_images ORDER BY id DESC LIMIT 1`);
  const galleryId = gallery.rows[0].id;

  const { status, body } = await req('POST', `/comments/gallery_image/${galleryId}`, {
    token: tokenFor(commenter),
    body: { body: 'lovely photo' },
  });
  assert.equal(status, 201);
  assert.ok(body.comment.id);

  const row = await pool.query(`SELECT target_type, target_id, status FROM content_comments WHERE id = $1`, [body.comment.id]);
  assert.equal(row.rows[0].target_type, 'gallery_image');
  assert.equal(row.rows[0].target_id, galleryId);
  assert.equal(row.rows[0].status, 'pending'); // moderation queue, same as before
});

test('an unrecognised targetType is rejected with 400, not a raw DB error', async () => {
  const commenter = await makeUser();
  const { status, body } = await req('POST', '/comments/spaceship/1', {
    token: tokenFor(commenter),
    body: { body: 'hello' },
  });
  assert.equal(status, 400);
  assert.match(body.error, /targetType must be one of/);
});

test('GET /comments/article/:id still works with the exact same URL shape as before this migration', async () => {
  const author = await makeUser();
  const commenter = await makeUser();
  const admin = await makeUser('admin');
  const articleId = await makeArticle(author);

  const post = await req('POST', `/comments/article/${articleId}`, { token: tokenFor(commenter), body: { body: 'nice read' } });
  assert.equal(post.status, 201);
  await req('PATCH', `/comments/${post.body.comment.id}/status`, { token: tokenFor(admin, 'admin'), body: { status: 'approved' } });

  const { status, body } = await req('GET', `/comments/article/${articleId}`);
  assert.equal(status, 200);
  assert.equal(body.comments.length, 1);
  assert.equal(body.comments[0].body, 'nice read');
});

test('admin pending queue reports target_type and a human-readable target_title across content types', async () => {
  const author = await makeUser();
  const commenter = await makeUser();
  const admin = await makeUser('admin');
  const articleId = await makeArticle(author);
  await req('POST', `/comments/article/${articleId}`, { token: tokenFor(commenter), body: { body: 'pending comment' } });

  const { status, body } = await req('GET', '/comments/pending', { token: tokenFor(admin, 'admin') });
  assert.equal(status, 200);
  const found = body.comments.find((c) => c.body === 'pending comment');
  assert.ok(found);
  assert.equal(found.target_type, 'article');
  assert.ok(found.target_title); // the article's title, via get_target_title()
});

test('re-running every migration is idempotent — content_comments rows survive, article_comments stays gone', async () => {
  const before1 = await pool.query('SELECT COUNT(*)::INTEGER AS n FROM content_comments');
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }
  const after1 = await pool.query('SELECT COUNT(*)::INTEGER AS n FROM content_comments');
  assert.equal(before1.rows[0].n, after1.rows[0].n);

  const table = await pool.query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'article_comments'`);
  assert.equal(table.rows.length, 0);
});
