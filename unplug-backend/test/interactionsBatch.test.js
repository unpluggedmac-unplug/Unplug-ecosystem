// Members/Community System follow-up — batch stats/mine endpoints on the
// Universal Interaction Engine, added so grid views (gallery, marketplace,
// news, homepage cards) fetch one round trip for a whole page of cards
// instead of one /stats + one /mine call per card. Over real HTTP against
// real PostgreSQL. See universalComments.test.js for why
// require('../src/app') is avoided.
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
let server;
let baseUrl;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-intbatch-'));
const port = 19600 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

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
  return jwt.sign({ id: userId, email: `intbatch${userId}@test.com`, role }, process.env.JWT_SECRET);
}

let _nextUserId = 22000;
async function makeUser() {
  const id = _nextUserId++;
  await pool.query(`INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', 'member') ON CONFLICT DO NOTHING`, [id, `intbatch${id}@test.com`]);
  return id;
}

let _nextArticleId = 0;
async function makeArticle(authorId) {
  const result = await pool.query(
    `INSERT INTO articles (author_user_id, title, body, status) VALUES ($1, $2, 'body', 'approved') RETURNING id`,
    [authorId, `Batch Interaction Article ${_nextArticleId++}`]
  );
  return result.rows[0].id;
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
  process.env.JWT_SECRET = 'test-secret-for-intbatch';

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
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await pool.end();
  await pg.stop();
});

test('batch-stats returns real counts per id in one call, and skips ids nobody reacted to', async () => {
  const liker = await makeUser();
  const author = await makeUser();
  const a1 = await makeArticle(author);
  const a2 = await makeArticle(author);
  const a3 = await makeArticle(author); // never touched

  await req('POST', `/interactions/article/${a1}/react`, { token: tokenFor(liker), body: { reaction: 'like' } });
  await req('POST', `/interactions/article/${a2}/react`, { token: tokenFor(liker), body: { reaction: 'dislike' } });

  const { status, body } = await req('GET', `/interactions/article/batch-stats?ids=${a1},${a2},${a3}`);
  assert.equal(status, 200);
  assert.equal(body.stats[a1].likes, 1);
  assert.equal(body.stats[a2].dislikes, 1);
  assert.equal(body.stats[a3].likes, 0);
  assert.equal(body.stats[a3].dislikes, 0);
});

test('batch-mine reflects the signed-in caller\'s own reaction/save state across ids, unauthenticated request is rejected', async () => {
  const me = await makeUser();
  const author = await makeUser();
  const a1 = await makeArticle(author);
  const a2 = await makeArticle(author);

  await req('POST', `/interactions/article/${a1}/react`, { token: tokenFor(me), body: { reaction: 'like' } });
  await req('POST', `/interactions/article/${a2}/save`, { token: tokenFor(me) });

  const mine = await req('GET', `/interactions/article/batch-mine?ids=${a1},${a2}`, { token: tokenFor(me) });
  assert.equal(mine.status, 200);
  assert.equal(mine.body.mine[a1].reaction, 'like');
  assert.equal(mine.body.mine[a1].saved, false);
  assert.equal(mine.body.mine[a2].reaction, null);
  assert.equal(mine.body.mine[a2].saved, true);

  const anon = await req('GET', `/interactions/article/batch-mine?ids=${a1},${a2}`);
  assert.equal(anon.status, 401);
});

test('batch-stats works across any of the five target types, not just articles', async () => {
  const owner = await makeUser();
  const profile = await pool.query(
    `INSERT INTO profiles (user_id, type, package_tier, slug, display_name, status) VALUES ($1, 'individual', 'basic', $2, $2, 'approved') RETURNING id`,
    [owner, `batch-test-profile-${owner}`]
  );
  const profileId = profile.rows[0].id;
  const liker = await makeUser();
  await req('POST', `/interactions/profile/${profileId}/react`, { token: tokenFor(liker), body: { reaction: 'like' } });

  const { status, body } = await req('GET', `/interactions/profile/batch-stats?ids=${profileId}`);
  assert.equal(status, 200);
  assert.equal(body.stats[profileId].likes, 1);
});

test('an invalid targetType is rejected, and an empty ids list returns an empty map rather than erroring', async () => {
  const bad = await req('GET', '/interactions/not-a-real-type/batch-stats?ids=1,2');
  assert.equal(bad.status, 400);

  const empty = await req('GET', '/interactions/article/batch-stats?ids=');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.stats, {});
});
