// South African Sign Language videos, against a REAL PostgreSQL.
//
// What this protects:
//
//   1. CAPTIONS ARE NOT OPTIONAL WHEN PUBLISHING. A signed video with no
//      captions leaves out every deaf person who does not sign, and everybody
//      watching with the sound off. Refused on BOTH routes that can publish —
//      the create call carrying isPublished:true would otherwise walk straight
//      past the check on the publish route.
//   2. A DRAFT NEVER APPEARS ON THE SITE. Off when created, like popups,
//      automations, social posts and forms.
//   3. ONE VIDEO PER THING. A second row for the same article would be an
//      editorial accident, not a feature.
//   4. IT IS ADMIN-ONLY TO WRITE.
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
let adminToken;
let memberToken;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-sasl-'));
const port = 44400 + (process.pid % 300); // bases are 400 apart so ranges cannot overlap

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

const VIDEO = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const VTT = 'WEBVTT\n\n00:00:00.000 --> 00:00:04.000\nWelcome to Unplug.';

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
  process.env.JWT_SECRET = 'test-secret-for-sasl';
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
  app.use('/sasl', require('../src/routes/sasl'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await pool.query(`INSERT INTO users (id, email, full_name, password_hash, role) VALUES
    (590001, 'sasladmin@test.com', 'SASL Admin', 'x', 'admin'),
    (590002, 'saslmember@test.com', 'SASL Member', 'x', 'member')`);
  adminToken = jwt.sign({ id: 590001, email: 'sasladmin@test.com', role: 'admin' }, process.env.JWT_SECRET);
  memberToken = jwt.sign({ id: 590002, email: 'saslmember@test.com', role: 'member' }, process.env.JWT_SECRET);

  await pool.query(`INSERT INTO categories (id, name, type) VALUES (9801, 'News', 'news')
                    ON CONFLICT (id) DO NOTHING`);
  await pool.query(
    `INSERT INTO articles (id, author_user_id, category_id, title, body, status, published_at)
     VALUES (9901, 590001, 9801, 'A Story With Signing', 'Body.', 'approved', now())`);
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
});

const reset = () => pool.query('DELETE FROM sasl_videos');

// ---------------------------------------------------------------- captions

test('CAPTIONS ARE REQUIRED TO PUBLISH — on the create call', async () => {
  await reset();
  const { status, body } = await api('POST', '/sasl/admin', {
    targetType: 'article', targetId: '9901', videoUrl: VIDEO, isPublished: true,
  }, adminToken);
  assert.equal(status, 400);
  assert.match(body.error, /captions/i);
  assert.match(body.error, /do not sign|without sound/i, 'and says why, not just that it is refused');
});

test('CAPTIONS ARE REQUIRED TO PUBLISH — on the publish call too', async () => {
  await reset();
  const created = await api('POST', '/sasl/admin', {
    targetType: 'article', targetId: '9901', videoUrl: VIDEO,
  }, adminToken);
  assert.equal(created.status, 201, 'saving a DRAFT without captions is fine');

  const publish = await api('PATCH', `/sasl/admin/${created.body.video.id}/publish`,
    { isPublished: true }, adminToken);
  assert.equal(publish.status, 400);
  assert.match(publish.body.error, /captions/i);
});

test('with captions it publishes', async () => {
  await reset();
  const { status, body } = await api('POST', '/sasl/admin', {
    targetType: 'article', targetId: '9901', videoUrl: VIDEO,
    captionsVtt: VTT, isPublished: true, signerName: 'Thandi',
  }, adminToken);
  assert.equal(status, 201);
  assert.equal(body.video.is_published, true);
  assert.equal(body.video.signer_name, 'Thandi');
});

test('captions that are not WebVTT are refused rather than silently stored', async () => {
  await reset();
  const { status, body } = await api('POST', '/sasl/admin', {
    targetType: 'article', targetId: '9901', videoUrl: VIDEO,
    captionsVtt: 'just some text I typed',
  }, adminToken);
  assert.equal(status, 400);
  assert.match(body.error, /WEBVTT/);
});

// ------------------------------------------------------------- publication

test('A DRAFT NEVER APPEARS ON THE SITE', async () => {
  await reset();
  await api('POST', '/sasl/admin', {
    targetType: 'article', targetId: '9901', videoUrl: VIDEO, captionsVtt: VTT,
  }, adminToken);
  const { body } = await api('GET', '/sasl?targetType=article&targetId=9901');
  assert.equal(body.video, null, 'off when created, like everything else that interrupts a reader');
});

test('a published video is served to the public with its captions', async () => {
  await reset();
  await api('POST', '/sasl/admin', {
    targetType: 'article', targetId: '9901', videoUrl: VIDEO,
    captionsVtt: VTT, isPublished: true,
  }, adminToken);
  const { status, body } = await api('GET', '/sasl?targetType=article&targetId=9901');
  assert.equal(status, 200);
  assert.ok(body.video, 'found');
  assert.equal(body.video.captions_vtt, VTT);
  assert.ok(body.video.embed_url, 'and an embeddable address, worked out once on the server');
});

test('asking about something with no video is not an error', async () => {
  const { status, body } = await api('GET', '/sasl?targetType=article&targetId=999999');
  assert.equal(status, 200);
  assert.equal(body.video, null);
});

test('a page can have one too, not only an article', async () => {
  await reset();
  const { status } = await api('POST', '/sasl/admin', {
    targetType: 'page', targetId: 'deafcommunity', videoUrl: VIDEO,
    captionsVtt: VTT, isPublished: true,
  }, adminToken);
  assert.equal(status, 201);
  const got = await api('GET', '/sasl?targetType=page&targetId=deafcommunity');
  assert.ok(got.body.video);
});

// ------------------------------------------------------------------- rules

test('ONE VIDEO PER THING — saving again replaces rather than duplicating', async () => {
  await reset();
  await api('POST', '/sasl/admin', {
    targetType: 'article', targetId: '9901', videoUrl: VIDEO, captionsVtt: VTT,
    signerName: 'First',
  }, adminToken);
  await api('POST', '/sasl/admin', {
    targetType: 'article', targetId: '9901', videoUrl: VIDEO, captionsVtt: VTT,
    signerName: 'Second',
  }, adminToken);
  const rows = await pool.query(
    `SELECT signer_name FROM sasl_videos WHERE target_type = 'article' AND target_id = '9901'`);
  assert.equal(rows.rows.length, 1, 'one row, not two');
  assert.equal(rows.rows[0].signer_name, 'Second');
});

test('a target id has to be the right shape for its type', async () => {
  for (const body of [
    { targetType: 'article', targetId: 'not-a-number' },
    { targetType: 'page', targetId: 'Not A Page Name' },
    { targetType: 'nonsense', targetId: '1' },
    { targetType: 'article', targetId: '' },
  ]) {
    const { status } = await api('POST', '/sasl/admin', { ...body, videoUrl: VIDEO }, adminToken);
    assert.equal(status, 400, JSON.stringify(body) + ' must be refused');
  }
});

test('a video link is validated by the same rules as every other video', async () => {
  const bad = await api('POST', '/sasl/admin', {
    targetType: 'article', targetId: '9901', videoUrl: 'javascript:alert(1)',
  }, adminToken);
  assert.equal(bad.status, 400);

  const embedCode = await api('POST', '/sasl/admin', {
    targetType: 'article', targetId: '9901', videoUrl: '<iframe src="https://youtube.com/embed/x"></iframe>',
  }, adminToken);
  assert.equal(embedCode.status, 400);
  assert.match(embedCode.body.error, /embed code/i, 'and names the actual mistake');
});

test('IT IS ADMIN-ONLY TO WRITE', async () => {
  await reset();
  const asMember = await api('POST', '/sasl/admin', {
    targetType: 'article', targetId: '9901', videoUrl: VIDEO, captionsVtt: VTT,
  }, memberToken);
  assert.equal(asMember.status, 403);

  const anonymous = await api('POST', '/sasl/admin', {
    targetType: 'article', targetId: '9901', videoUrl: VIDEO, captionsVtt: VTT,
  });
  assert.equal(anonymous.status, 401);
});

test('unpublishing takes it off the site again', async () => {
  await reset();
  const created = await api('POST', '/sasl/admin', {
    targetType: 'article', targetId: '9901', videoUrl: VIDEO,
    captionsVtt: VTT, isPublished: true,
  }, adminToken);
  await api('PATCH', `/sasl/admin/${created.body.video.id}/publish`, { isPublished: false }, adminToken);
  const { body } = await api('GET', '/sasl?targetType=article&targetId=9901');
  assert.equal(body.video, null);
});

test('the public index lists published videos with the article title', async () => {
  await reset();
  await api('POST', '/sasl/admin', {
    targetType: 'article', targetId: '9901', videoUrl: VIDEO,
    captionsVtt: VTT, isPublished: true,
  }, adminToken);
  const { body } = await api('GET', '/sasl/all');
  assert.equal(body.videos.length, 1);
  assert.equal(body.videos[0].article_title, 'A Story With Signing');
});

test('re-running every migration is idempotent and keeps the videos', async () => {
  await reset();
  await api('POST', '/sasl/admin', {
    targetType: 'article', targetId: '9901', videoUrl: VIDEO,
    captionsVtt: VTT, isPublished: true,
  }, adminToken);
  await runMigrations();
  const rows = await pool.query('SELECT is_published FROM sasl_videos');
  assert.equal(rows.rows.length, 1, 'a re-run does not lose the video');
  assert.equal(rows.rows[0].is_published, true, 'nor unpublish it');
});
