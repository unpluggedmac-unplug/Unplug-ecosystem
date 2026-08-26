// Videos on articles, against a REAL PostgreSQL.
//
// A writer pastes ONE link and the platform is worked out from it. The things
// that have to hold:
//
//   1. NOTHING A PERSON TYPED EVER REACHES AN IFRAME. Only the video's id is
//      taken out of the link and the player address is rebuilt by us. Pasted
//      embed code is refused, not stored — storing markup and putting it in a
//      page is how an article ends up running somebody else's script;
//   2. a link we cannot turn into a player is refused AT SAVE TIME, because a
//      stored dead link is an empty box on a published page that nobody
//      notices until a reader says so;
//   3. members and admins use the same path, so a member submission carries a
//      video exactly as an admin-written one does;
//   4. no cover image is ever required. YouTube supplies its own thumbnail;
//      the other three supply none and the page shows a branded panel;
//   5. an article without a video is unaffected — which is every article that
//      already exists.
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
let buildVideoEmbed;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-artvideo-'));
const port = 34400 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

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
  return jwt.sign({ id: userId, email: `av${userId}@test.com`, role }, process.env.JWT_SECRET);
}

let _nextUserId = 1101000;
async function makeUser(role = 'member') {
  const id = _nextUserId++;
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', $3) ON CONFLICT DO NOTHING`,
    [id, `av${id}@test.com`, role]);
  return id;
}

let _n = 0;
async function submit(token, over = {}) {
  return req('POST', '/articles', {
    token,
    body: { title: 'Video Story ' + (++_n), body: 'A story with a video in it.', ...over },
  });
}

async function stored(id) {
  const r = await pool.query(
    'SELECT video_url, video_platform, video_embed_url, video_thumbnail_url FROM articles WHERE id = $1',
    [id]);
  return r.rows[0];
}

let adminToken;
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
  process.env.JWT_SECRET = 'test-secret-for-article-video';
  process.env.UNPLUG_DISABLE_RATE_LIMITS = '1';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }

  jwt = require('jsonwebtoken');
  ({ buildVideoEmbed } = require('../src/utils/videoEmbed'));

  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/articles', require('../src/routes/articles'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  adminToken = tokenFor(await makeUser('admin'), 'admin');
  memberToken = tokenFor(await makeUser());
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
// Nothing a person typed reaches a frame
// ---------------------------------------------------------------------------

test('PASTED EMBED CODE IS REFUSED, NOT STORED', async () => {
  // The obvious mistake: copying "embed code" off YouTube instead of the link.
  // Storing markup and rendering it is how an article runs someone else's
  // script, so this is refused rather than sanitised.
  const bad = await submit(adminToken, {
    videoUrl: '<iframe src="https://evil.example/x"></iframe>',
  });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /embed code/i,
    'the message names the actual mistake, or the person pastes it again');
});

test('a javascript: address never becomes a player', async () => {
  const bad = await submit(adminToken, { videoUrl: 'javascript:alert(document.cookie)' });
  assert.equal(bad.status, 400);
});

test('THE EMBED URL IS BUILT BY US, NOT TAKEN FROM THE LINK', async () => {
  const created = await submit(adminToken, {
    videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLtracking&t=42',
  });
  assert.equal(created.status, 201);
  const row = await stored(created.body.article.id);
  assert.equal(row.video_embed_url, 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    'only the id survives — the tracking parameters do not follow the reader');
  assert.ok(!row.video_embed_url.includes('PLtracking'));
});

test('the raw link is kept as well, so an editor can see what was pasted', async () => {
  const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  const created = await submit(adminToken, { videoUrl: url });
  const row = await stored(created.body.article.id);
  assert.equal(row.video_url, url);
});

// ---------------------------------------------------------------------------
// Every platform the owner asked for
// ---------------------------------------------------------------------------

test('ALL FOUR PLATFORMS WORK FROM A PLAIN PASTED LINK', async () => {
  const cases = [
    ['youtube',   'https://youtu.be/abc123XYZ'],
    ['youtube',   'https://www.youtube.com/shorts/short123ID'],
    ['tiktok',    'https://www.tiktok.com/@someone/video/7412345678901234567'],
    ['instagram', 'https://www.instagram.com/reel/Cxyz123/?igshid=abc'],
    ['gdrive',    'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view?usp=sharing'],
  ];
  for (const [platform, url] of cases) {
    const created = await submit(adminToken, { videoUrl: url });
    assert.equal(created.status, 201, `${url} was refused: ${created.body && created.body.error}`);
    const row = await stored(created.body.article.id);
    assert.equal(row.video_platform, platform, url);
    assert.ok(row.video_embed_url, `${url} produced no player address`);
  }
});

test('NO COVER IMAGE IS EVER ASKED FOR — YouTube brings its own, the rest bring none', async () => {
  const yt = await submit(adminToken, { videoUrl: 'https://youtu.be/abc123XYZ' });
  const ytRow = await stored(yt.body.article.id);
  assert.match(ytRow.video_thumbnail_url, /ytimg\.com/,
    'a YouTube video shows its real frame with nothing to choose');

  const tt = await submit(adminToken, { videoUrl: 'https://www.tiktok.com/@x/video/7412345678901234567' });
  const ttRow = await stored(tt.body.article.id);
  assert.equal(ttRow.video_thumbnail_url, null,
    'TikTok publishes no thumbnail we can use, so the page shows a branded panel instead');
});

test('a platform we do not support is refused with a message naming the ones we do', async () => {
  const bad = await submit(adminToken, { videoUrl: 'https://vimeo.com/12345' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /YouTube.*TikTok.*Instagram.*Google Drive/i);
});

test('a TikTok short link is refused with instructions rather than stored broken', async () => {
  // vm.tiktok.com links only resolve by following a redirect, so they cannot
  // be embedded. Saying what to paste beats saving something that shows an
  // empty box.
  const bad = await submit(adminToken, { videoUrl: 'https://vm.tiktok.com/ZMabcdef/' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /full link/i);
});

// ---------------------------------------------------------------------------
// Every pathway, not just the admin one
// ---------------------------------------------------------------------------

test('A MEMBER SUBMISSION CARRIES A VIDEO THE SAME WAY AN ADMIN ONE DOES', async () => {
  // The owner asked for this on every path. Members go through the same
  // POST /articles, so this proves it rather than assuming it.
  const created = await submit(memberToken, { videoUrl: 'https://youtu.be/memberVID1' });
  assert.equal(created.status, 201);
  const row = await stored(created.body.article.id);
  assert.equal(row.video_platform, 'youtube');
  assert.equal(row.video_embed_url, 'https://www.youtube-nocookie.com/embed/memberVID1');
});

test('a bad link from a member is refused just as firmly', async () => {
  const bad = await submit(memberToken, { videoUrl: '<script>alert(1)</script>' });
  assert.equal(bad.status, 400);
});

test('EDITING AN ARTICLE CAN ADD, CHANGE OR REMOVE THE VIDEO', async () => {
  const created = await submit(adminToken, {});
  const id = created.body.article.id;
  assert.equal((await stored(id)).video_embed_url, null, 'starts with none');

  await req('PATCH', `/articles/${id}`, {
    token: adminToken, body: { videoUrl: 'https://youtu.be/firstVIDEO' },
  });
  assert.match((await stored(id)).video_embed_url, /firstVIDEO/, 'added');

  await req('PATCH', `/articles/${id}`, {
    token: adminToken, body: { videoUrl: 'https://www.tiktok.com/@x/video/7412345678901234567' },
  });
  const swapped = await stored(id);
  assert.equal(swapped.video_platform, 'tiktok', 'changed, including the platform');
  assert.equal(swapped.video_thumbnail_url, null, 'and the old YouTube thumbnail did not linger');

  const removed = await req('PATCH', `/articles/${id}`, {
    token: adminToken, body: { videoUrl: '' },
  });
  assert.equal(removed.status, 200);
  const gone = await stored(id);
  assert.equal(gone.video_embed_url, null, 'an empty box takes the video off the story');
  assert.equal(gone.video_platform, null);
});

test('a bad link in an EDIT does not wipe the video already there', async () => {
  const created = await submit(adminToken, { videoUrl: 'https://youtu.be/keepMEplz' });
  const id = created.body.article.id;
  const bad = await req('PATCH', `/articles/${id}`, {
    token: adminToken, body: { videoUrl: 'https://vimeo.com/999' },
  });
  assert.equal(bad.status, 400);
  assert.match((await stored(id)).video_embed_url, /keepMEplz/,
    'a rejected edit must leave the story exactly as it was');
});

// ---------------------------------------------------------------------------
// Articles without a video
// ---------------------------------------------------------------------------

test('AN ARTICLE WITH NO VIDEO IS COMPLETELY UNAFFECTED', async () => {
  // Which is every article that already exists.
  const created = await submit(adminToken, {});
  assert.equal(created.status, 201);
  const row = await stored(created.body.article.id);
  assert.equal(row.video_url, null);
  assert.equal(row.video_platform, null);
  assert.equal(row.video_embed_url, null);
  assert.equal(row.video_thumbnail_url, null);
});

test('the public article read carries the video fields for the page to render', async () => {
  const created = await submit(adminToken, { videoUrl: 'https://youtu.be/publicVID' });
  const id = created.body.article.id;
  await pool.query(`UPDATE articles SET status = 'approved', published_at = now() WHERE id = $1`, [id]);

  const shown = await req('GET', `/articles/${id}`);
  assert.equal(shown.status, 200);
  const a = shown.body.article || shown.body;
  assert.equal(a.video_platform, 'youtube');
  assert.ok(a.video_embed_url, 'without this the page has nothing to put in the player');
  assert.ok(a.video_thumbnail_url);
});

// ---------------------------------------------------------------------------
// The parser itself
// ---------------------------------------------------------------------------

test('the parser never throws, whatever it is handed', async () => {
  // It runs on every article save; an exception here would lose the article.
  for (const input of [null, undefined, '', '   ', 'http://', '://nope', 12345, {}, [],
    'https://', 'https://[bad', 'a'.repeat(600)]) {
    const r = buildVideoEmbed(input);
    assert.ok(r && 'platform' in r, `buildVideoEmbed(${JSON.stringify(input)}) must return a shape`);
  }
});

test('an empty link is simply no video, not an error', async () => {
  // A writer who leaves the box alone must not be blocked from publishing.
  const r = buildVideoEmbed('');
  assert.equal(r.platform, null);
  assert.equal(r.error, null);
});

test('Google Drive saves but warns about sharing, because we cannot detect it', async () => {
  // A private Drive file looks identical to a shared one from outside, so the
  // only moment to say anything is when it is pasted.
  const r = buildVideoEmbed('https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view');
  assert.equal(r.platform, 'gdrive');
  assert.equal(r.error, null, 'it is not an error — it saves');
  assert.match(r.warning, /Anyone with the link/i);
});
