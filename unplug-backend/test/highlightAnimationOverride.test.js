// Part 4 of "admin control over banner/cover animation effects": a per-
// placement OVERRIDE of a Highlighted Article's entrance effect/speed —
// mirroring the exact relationship admin_image_url already has to
// articles.banner_image_url on this same table. NULL means "use the
// article's own cover_animation_effect/cover_transition_duration_ms" (from
// part 3); a real value overrides it for this placement only.
//
// Run with:  npm test   (from unplug-backend/)

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const jwt = require('jsonwebtoken');
const EmbeddedPostgres = require('embedded-postgres').default;
const { stopPostgres } = require('./helpers/stopPostgres');

let pg;
let pool;
let server;
let baseUrl;
let adminToken, memberToken;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-hlanim-'));
const port = 60800 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

async function req(method, urlPath, { token, body } = {}) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, body: json };
}

let articleId;

before(async () => {
  pg = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'postgres', password: 'postgres', port,
    persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('unplug_test');

  process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${port}/unplug_test`;
  process.env.JWT_SECRET = 'test-secret-for-highlight-animation-override';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }

  await pool.query(`INSERT INTO users (id, email, password_hash, role)
                    VALUES (1, 'admin@test.com', 'x', 'admin'), (2, 'member@test.com', 'x', 'member')
                    ON CONFLICT DO NOTHING`);
  adminToken = jwt.sign({ id: 1, email: 'admin@test.com', role: 'admin' }, process.env.JWT_SECRET);
  memberToken = jwt.sign({ id: 2, email: 'member@test.com', role: 'member' }, process.env.JWT_SECRET);

  const article = await pool.query(
    `INSERT INTO articles (title, body, status, banner_image_url, author_user_id, cover_animation_effect, cover_transition_duration_ms)
     VALUES ('Test Article', 'body', 'approved', 'https://a.test/art.jpg', 1, 'fade', 350) RETURNING id`
  );
  articleId = article.rows[0].id;

  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/highlights', require('../src/routes/highlights'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}, { timeout: 120000 });

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('THE MIGRATION ITSELF REJECTS AN INVALID EFFECT, BUT ALLOWS NULL (UNLIKE EVERY OTHER PART)', async () => {
  await assert.rejects(
    pool.query(`INSERT INTO highlights (target_type, target_id, animation_effect) VALUES ('article', $1, 'spin')`, [articleId]),
    /violates check constraint/
  );
  const r = await pool.query(`INSERT INTO highlights (target_type, target_id) VALUES ('article', $1) RETURNING animation_effect, transition_duration_ms`, [articleId]);
  assert.equal(r.rows[0].animation_effect, null, 'no override by default — unlike every other part, NULL is the correct default here');
  assert.equal(r.rows[0].transition_duration_ms, null);
});

test('A NON-ADMIN CANNOT CREATE A HIGHLIGHT WITH AN OVERRIDE', async () => {
  const r = await req('POST', '/highlights/admin', {
    token: memberToken, body: { targetType: 'article', targetId: articleId, animationEffect: 'zoom' },
  });
  assert.equal(r.status, 403);
});

test('AN INVALID animationEffect ON CREATE IS A CLEAN 400', async () => {
  const r = await req('POST', '/highlights/admin', {
    token: adminToken, body: { targetType: 'article', targetId: articleId, animationEffect: 'spin' },
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /animationEffect must be one of/);
});

let highlightId;

test('CREATING A HIGHLIGHT WITH NO OVERRIDE LEAVES BOTH FIELDS NULL', async () => {
  const r = await req('POST', '/highlights/admin', {
    token: adminToken, body: { targetType: 'article', targetId: articleId },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.highlight.animation_effect, null);
  assert.equal(r.body.highlight.transition_duration_ms, null);
  highlightId = r.body.highlight.id;
});

test('GET /highlights/active RETURNS animation_effect:null FOR A HIGHLIGHT WITH NO OVERRIDE', async () => {
  const r = await req('GET', '/highlights/active');
  assert.equal(r.status, 200);
  const h = r.body.highlights.find((x) => x.id === highlightId);
  assert.ok(h);
  assert.equal(h.animation_effect, null);
  assert.equal(h.transition_duration_ms, null);
});

test('PATCHING IN A REAL OVERRIDE STICKS, AND GET /highlights/active REFLECTS IT', async () => {
  const r = await req('PATCH', `/highlights/admin/${highlightId}`, {
    token: adminToken, body: { animationEffect: 'zoom', transitionDurationMs: 600 },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.highlight.animation_effect, 'zoom');
  assert.equal(r.body.highlight.transition_duration_ms, 600);

  const active = await req('GET', '/highlights/active');
  const h = active.body.highlights.find((x) => x.id === highlightId);
  assert.equal(h.animation_effect, 'zoom');
  assert.equal(h.transition_duration_ms, 600);
});

test('AN INVALID animationEffect ON PATCH IS A CLEAN 400, LEAVING THE STORED OVERRIDE UNCHANGED', async () => {
  const r = await req('PATCH', `/highlights/admin/${highlightId}`, {
    token: adminToken, body: { animationEffect: 'spin' },
  });
  assert.equal(r.status, 400);
  const active = await req('GET', '/highlights/active');
  const h = active.body.highlights.find((x) => x.id === highlightId);
  assert.equal(h.animation_effect, 'zoom', 'the previous valid override must still be in place');
});

test('AN OUT-OF-RANGE transitionDurationMs ON PATCH IS A CLEAN 400', async () => {
  const r = await req('PATCH', `/highlights/admin/${highlightId}`, {
    token: adminToken, body: { transitionDurationMs: -10 },
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /transitionDurationMs must be a positive whole number/);
});

test('SENDING AN EMPTY STRING CLEARS THE OVERRIDE BACK TO NULL — "use the article\'s own setting"', async () => {
  const r = await req('PATCH', `/highlights/admin/${highlightId}`, {
    token: adminToken, body: { animationEffect: '', transitionDurationMs: '' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.highlight.animation_effect, null);
  assert.equal(r.body.highlight.transition_duration_ms, null);
});
