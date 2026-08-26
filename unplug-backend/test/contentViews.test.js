// View counts for gallery images and every other interaction target
// (103_content_views.sql), plus confirmation that gallery comments — which
// the universal comments engine already supported server-side — really do
// work end to end for a gallery image.
//
// The interesting parts are the dedupe rules: a refresh must not inflate a
// count, two different viewers must both count, and the same viewer must
// count again tomorrow.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-contentviews-'));
const port = 22400 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

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

let jwt;
function tokenFor(userId, role = 'member') {
  return jwt.sign({ id: userId, email: `views${userId}@test.com`, role }, process.env.JWT_SECRET);
}

let _nextUserId = 61000;
async function makeUser(role = 'member') {
  const id = _nextUserId++;
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', $3) ON CONFLICT DO NOTHING`,
    [id, `views${id}@test.com`, role]
  );
  return id;
}

let _nextImg = 0;
async function makeGalleryImage() {
  // owner_type is NOT NULL with a CHECK of profile|investor|general — a
  // community photo with no owning profile is 'general'.
  const r = await pool.query(
    `INSERT INTO gallery_images (owner_type, image_url, caption, status)
     VALUES ('general', $1, $2, 'approved') RETURNING id`,
    [`https://example.test/g${_nextImg}.jpg`, `Gallery image ${_nextImg++}`]
  );
  return r.rows[0].id;
}

async function viewCount(targetType, targetId) {
  const r = await pool.query('SELECT views FROM get_content_stats($1, $2)', [targetType, targetId]);
  return r.rows[0].views;
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
  process.env.JWT_SECRET = 'test-secret-for-contentviews';
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
  app.use('/interactions', require('../src/routes/interactions'));
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

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

test('a guest view is recorded and reported back', async () => {
  const img = await makeGalleryImage();
  assert.equal(await viewCount('gallery_image', img), 0);

  const { status, body } = await req('POST', `/interactions/gallery_image/${img}/view`, {
    body: { sessionId: 'guest-view-1' },
  });
  assert.equal(status, 200);
  assert.equal(body.views, 1);
  assert.equal(await viewCount('gallery_image', img), 1);
});

test('the same viewer refreshing does NOT inflate the count', async () => {
  const img = await makeGalleryImage();
  for (let i = 0; i < 5; i += 1) {
    await req('POST', `/interactions/gallery_image/${img}/view`, { body: { sessionId: 'guest-refresh' } });
  }
  assert.equal(await viewCount('gallery_image', img), 1, 'five refreshes must still be one view');
});

test('different viewers each count once', async () => {
  const img = await makeGalleryImage();
  await req('POST', `/interactions/gallery_image/${img}/view`, { body: { sessionId: 'guest-a' } });
  await req('POST', `/interactions/gallery_image/${img}/view`, { body: { sessionId: 'guest-b' } });
  const member = await makeUser();
  await req('POST', `/interactions/gallery_image/${img}/view`, { token: tokenFor(member) });
  assert.equal(await viewCount('gallery_image', img), 3);
});

test('a signed-in viewer is counted separately from their guest session', async () => {
  // Someone who browses signed out and then signs in should not have their
  // earlier view silently discarded, nor be double-counted afterwards.
  const img = await makeGalleryImage();
  const member = await makeUser();
  await req('POST', `/interactions/gallery_image/${img}/view`, { body: { sessionId: 'sess-then-login' } });
  await req('POST', `/interactions/gallery_image/${img}/view`, { token: tokenFor(member) });
  await req('POST', `/interactions/gallery_image/${img}/view`, { token: tokenFor(member) });
  assert.equal(await viewCount('gallery_image', img), 2);
});

test('the same viewer counts again on a NEW day', async () => {
  const img = await makeGalleryImage();
  await req('POST', `/interactions/gallery_image/${img}/view`, { body: { sessionId: 'guest-daily' } });
  assert.equal(await viewCount('gallery_image', img), 1);

  // Pretend that view was yesterday — the only practical way to test a
  // day boundary without waiting for one.
  await pool.query(
    `UPDATE content_views SET view_day = view_day - INTERVAL '1 day'
      WHERE target_type = 'gallery_image' AND target_id = $1`, [img]
  );
  await req('POST', `/interactions/gallery_image/${img}/view`, { body: { sessionId: 'guest-daily' } });
  assert.equal(await viewCount('gallery_image', img), 2, 'a returning viewer should count again the next day');
});

test('a guest with no sessionId is rejected rather than counted anonymously', async () => {
  const img = await makeGalleryImage();
  const { status } = await req('POST', `/interactions/gallery_image/${img}/view`, { body: {} });
  assert.equal(status, 400);
  assert.equal(await viewCount('gallery_image', img), 0);
});

test('viewing something that does not exist is a 404', async () => {
  const { status } = await req('POST', '/interactions/gallery_image/99999999/view', { body: { sessionId: 's' } });
  assert.equal(status, 404);
});

test('an unknown target type is rejected', async () => {
  const { status } = await req('POST', '/interactions/not_a_type/1/view', { body: { sessionId: 's' } });
  assert.equal(status, 400);
});

test('views appear in single stats AND batch stats', async () => {
  // The gallery grid reads batch-stats; a single card repaint reads /stats.
  // Both had to gain the new column or the bar would show views on one path
  // and blank on the other.
  const a = await makeGalleryImage();
  const b = await makeGalleryImage();
  await req('POST', `/interactions/gallery_image/${a}/view`, { body: { sessionId: 'batch-1' } });
  await req('POST', `/interactions/gallery_image/${a}/view`, { body: { sessionId: 'batch-2' } });
  await req('POST', `/interactions/gallery_image/${b}/view`, { body: { sessionId: 'batch-1' } });

  const single = await req('GET', `/interactions/gallery_image/${a}/stats`);
  assert.equal(single.status, 200);
  assert.equal(single.body.views, 2);

  const batch = await req('GET', `/interactions/gallery_image/batch-stats?ids=${a},${b}`);
  assert.equal(batch.status, 200);
  assert.equal(batch.body.stats[a].views, 2);
  assert.equal(batch.body.stats[b].views, 1);
  // The columns that already existed must not have been disturbed.
  assert.equal(batch.body.stats[a].likes, 0);
  assert.equal(batch.body.stats[a].comments, 0);
});

// ---------------------------------------------------------------------------
// Gallery comments end to end
// ---------------------------------------------------------------------------

test('a member can comment on a gallery image and the count reflects it once approved', async () => {
  const img = await makeGalleryImage();
  const member = await makeUser();

  const posted = await req('POST', `/comments/gallery_image/${img}`, {
    token: tokenFor(member), body: { body: 'Beautiful shot.' },
  });
  assert.equal(posted.status, 201);

  // Moderated by default, so it is NOT public or counted yet.
  const before = await req('GET', `/comments/gallery_image/${img}`);
  assert.equal(before.body.comments.length, 0);
  const stats = await req('GET', `/interactions/gallery_image/${img}/stats`);
  assert.equal(stats.body.comments, 0, 'a pending comment must not be counted publicly');

  await pool.query(`UPDATE content_comments SET status = 'approved' WHERE id = $1`, [posted.body.comment.id]);

  const after = await req('GET', `/comments/gallery_image/${img}`);
  assert.equal(after.body.comments.length, 1);
  assert.equal(after.body.comments[0].body, 'Beautiful shot.');
  assert.ok(after.body.comments[0].author, 'a comment needs a display author');
  const stats2 = await req('GET', `/interactions/gallery_image/${img}/stats`);
  assert.equal(stats2.body.comments, 1);
});

test('a signed-out visitor cannot comment on a gallery image', async () => {
  const img = await makeGalleryImage();
  const { status } = await req('POST', `/comments/gallery_image/${img}`, { body: { body: 'spam' } });
  assert.equal(status, 401);
});

test('re-running every migration is idempotent — views survive and stats keep their new shape', async () => {
  const img = await makeGalleryImage();
  await req('POST', `/interactions/gallery_image/${img}/view`, { body: { sessionId: 'idem' } });

  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }

  assert.equal(await viewCount('gallery_image', img), 1);
  // The DROP/CREATE of get_content_stats must leave a 5-column function.
  const cols = await pool.query('SELECT * FROM get_content_stats($1, $2)', ['gallery_image', img]);
  assert.deepEqual(Object.keys(cols.rows[0]).sort(), ['comments', 'dislikes', 'likes', 'saves', 'views']);
});
