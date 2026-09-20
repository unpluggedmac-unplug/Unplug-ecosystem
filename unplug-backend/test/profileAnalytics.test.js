// Members, Profile Social Interaction & Community System — Phase 6:
// Public vs Private Profile Analytics, over real HTTP against real
// PostgreSQL. Mounts only profileAnalytics.js on a bare Express app —
// see universalComments.test.js for why require('../src/app') is
// avoided in this test suite.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-profileanalytics-'));
const port = 17600 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

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
  return jwt.sign({ id: userId, email: `pa${userId}@test.com`, role }, process.env.JWT_SECRET);
}

let _nextUserId = 18000;
async function makeUser() {
  const id = _nextUserId++;
  await pool.query(`INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', 'member') ON CONFLICT DO NOTHING`, [id, `pa${id}@test.com`]);
  return id;
}

let _nextSlug = 0;
async function makeProfile(userId, type = 'individual') {
  const slug = `pa-profile-${_nextSlug++}`;
  const result = await pool.query(
    `INSERT INTO profiles (user_id, type, package_tier, slug, display_name, status) VALUES ($1, $2, 'basic', $3, $3, 'approved') RETURNING id`,
    [userId, type, slug]
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
  process.env.JWT_SECRET = 'test-secret-for-profile-analytics';

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
  app.use('/profile-analytics', require('../src/routes/profileAnalytics'));
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

test('public analytics work for a fresh member with no activity — all zeros, not an error', async () => {
  const userId = await makeUser();
  const { status, body } = await req('GET', `/profile-analytics/${userId}/public`);
  assert.equal(status, 200);
  assert.equal(body.unplug_score, 0);
  assert.equal(body.followers, 0);
  assert.equal(body.articles_published, 0);
});

test('public analytics never expose contact details — no email/phone/address fields present', async () => {
  const userId = await makeUser();
  const { body } = await req('GET', `/profile-analytics/${userId}/public`);
  const keys = Object.keys(body);
  assert.ok(!keys.some((k) => /email|phone|address/i.test(k)));
});

test('followers/following counts reflect real Phase 4 follow relationships', async () => {
  const a = await makeUser();
  const b = await makeUser();
  await pool.query('SELECT follow_member($1, $2)', [a, b]);

  const bStats = await req('GET', `/profile-analytics/${b}/public`);
  const aStats = await req('GET', `/profile-analytics/${a}/public`);
  assert.equal(bStats.body.followers, 1);
  assert.equal(aStats.body.following, 1);
});

test('articles_published only counts approved articles by this author', async () => {
  const author = await makeUser();
  await pool.query(`INSERT INTO articles (author_user_id, title, body, status) VALUES ($1, 'A', 'b', 'approved')`, [author]);
  await pool.query(`INSERT INTO articles (author_user_id, title, body, status) VALUES ($1, 'B', 'b', 'pending')`, [author]);

  const { body } = await req('GET', `/profile-analytics/${author}/public`);
  assert.equal(body.articles_published, 1);
});

test('profile_likes/dislikes/saves reflect real Phase 1 interactions on this member\'s profile', async () => {
  const owner = await makeUser();
  const profileId = await makeProfile(owner);
  const liker = await makeUser();
  const disliker = await makeUser();
  const saver = await makeUser();
  await pool.query(`INSERT INTO content_reactions (user_id, target_type, target_id, reaction) VALUES ($1, 'profile', $2, 'like')`, [liker, profileId]);
  await pool.query(`INSERT INTO content_reactions (user_id, target_type, target_id, reaction) VALUES ($1, 'profile', $2, 'dislike')`, [disliker, profileId]);
  await pool.query(`INSERT INTO content_saves (user_id, target_type, target_id) VALUES ($1, 'profile', $2)`, [saver, profileId]);

  const { body } = await req('GET', `/profile-analytics/${owner}/public`);
  assert.equal(body.profile_likes, 1);
  assert.equal(body.profile_dislikes, 1);
  assert.equal(body.profile_saves, 1);
});

test('business_contributions is NULL for an individual profile, a real number for a business one', async () => {
  const individual = await makeUser();
  await makeProfile(individual, 'individual');
  const business = await makeUser();
  const bizProfileId = await makeProfile(business, 'business');
  const reviewer = await makeUser();
  await pool.query(`INSERT INTO profile_reviews (profile_id, user_id, rating, status) VALUES ($1, $2, 5, 'approved')`, [bizProfileId, reviewer]);

  const indStats = await req('GET', `/profile-analytics/${individual}/public`);
  const bizStats = await req('GET', `/profile-analytics/${business}/public`);
  assert.equal(indStats.body.business_contributions, null);
  assert.equal(bizStats.body.business_contributions, 1);
});

test('passport_completion_pct reflects real earned stamps out of enabled ones', async () => {
  const userId = await makeUser();
  const items = await pool.query(`SELECT COUNT(*)::INTEGER AS n FROM passport_items WHERE is_enabled = TRUE`);
  const total = items.rows[0].n;
  assert.ok(total > 0); // Stage C seeds real passport items — sanity check the fixture assumption
  await pool.query('SELECT award_passport_stamp($1, (SELECT code FROM passport_items WHERE is_enabled = TRUE LIMIT 1))', [userId]);

  const { body } = await req('GET', `/profile-analytics/${userId}/public`);
  const expectedPct = Math.round((1 / total) * 100);
  assert.equal(body.passport_completion_pct, expectedPct);
});

test('private analytics require auth and only ever return the caller\'s own data', async () => {
  const userId = await makeUser();
  const noAuth = await req('GET', '/profile-analytics/me/private');
  assert.equal(noAuth.status, 401);

  const { status, body } = await req('GET', '/profile-analytics/me/private', { token: tokenFor(userId) });
  assert.equal(status, 200);
  assert.equal(body.unplug_score, 0); // same public fields spread in
  assert.ok(Array.isArray(body.dailyPoints));
  assert.ok(Array.isArray(body.followerGrowth));
  assert.ok(Array.isArray(body.rankHistory));
  assert.ok(Array.isArray(body.recognitionBreakdown));
  assert.deepEqual(body.audience, {
    profileViews: 0,
    profileVisitors: 0,
    articleReads: 0,
    articleReaders: 0,
  });
  assert.ok(Array.isArray(body.dailyAudience));
  assert.ok(Array.isArray(body.topArticles));
});

test('private analytics dailyPoints and followerGrowth reflect this member\'s real recent activity', async () => {
  const userId = await makeUser();
  await pool.query(`SELECT award_points($1, 'achievement_earned', NULL, NULL, NULL, 25)`, [userId]);
  const follower = await makeUser();
  await pool.query('SELECT follow_member($1, $2)', [follower, userId]);

  const { body } = await req('GET', '/profile-analytics/me/private', { token: tokenFor(userId) });
  assert.equal(body.dailyPoints.length, 1);
  // Both land on today: the 25-point achievement AND the 5-point
  // follow_received award (Phase 4) triggered by follow_member() above —
  // dailyPoints correctly sums everything earned that day, not just one
  // action type.
  assert.equal(body.dailyPoints[0].points, 30);
  assert.equal(body.followerGrowth.length, 1);
  assert.equal(body.followerGrowth[0].new_followers, 1);
});

test('recognitionBreakdown groups by recognition type, scoped to this member', async () => {
  const userId = await makeUser();
  const giver1 = await makeUser();
  const giver2 = await makeUser();
  await pool.query(`SELECT * FROM process_recognition($1, $2, 'helpful')`, [giver1, userId]);
  await pool.query(`SELECT * FROM process_recognition($1, $2, 'inspiring')`, [giver2, userId]);

  const { body } = await req('GET', '/profile-analytics/me/private', { token: tokenFor(userId) });
  const types = body.recognitionBreakdown.map((r) => r.recognition_type).sort();
  assert.deepEqual(types, ['helpful', 'inspiring']);
});

test('private analytics report real profile and article audiences without leaking another creator or counting the owner', async () => {
  const owner = await makeUser();
  const profileId = await makeProfile(owner);
  const profile = await pool.query('SELECT slug FROM profiles WHERE id=$1', [profileId]);
  const article = await pool.query(
    `INSERT INTO articles (author_user_id,title,body,status)
     VALUES($1,'Owner story','Body','approved') RETURNING id`,
    [owner]
  );

  const otherOwner = await makeUser();
  const otherArticle = await pool.query(
    `INSERT INTO articles (author_user_id,title,body,status)
     VALUES($1,'Someone else''s story','Body','approved') RETURNING id`,
    [otherOwner]
  );

  const insertView = (values) => pool.query(
    `INSERT INTO analytics_events
       (session_id,visitor_id,event_name,page_path,entity_type,entity_id,user_id,occurred_at)
     VALUES($1,$2,'page_view',$3,$4,$5,$6,$7)`,
    values
  );
  const now = new Date();
  const old = new Date(Date.now() - 45 * 864e5);
  const profilePath = `profile-${profile.rows[0].slug}`;

  // Two real profile opens by one anonymous visitor: one legacy path-only
  // event and one newer entity-linked event. Both are real history and must
  // count as views, while the visitor remains one person.
  await insertView(['pa-session-profile-1', 'pa-visitor-profile', profilePath, null, null, null, now]);
  await insertView(['pa-session-profile-2', 'pa-visitor-profile', profilePath, 'profile', profileId, null, now]);

  // Two article reads by two visitors, plus an older read that only belongs in
  // the 90-day window.
  await insertView(['pa-session-article-1', 'pa-visitor-article-1', 'article-owner', 'article', article.rows[0].id, null, now]);
  await insertView(['pa-session-article-2', 'pa-visitor-article-2', 'article-owner', 'article', article.rows[0].id, null, now]);
  await insertView(['pa-session-article-old', 'pa-visitor-article-old', 'article-owner', 'article', article.rows[0].id, null, old]);

  // Neither the owner's own signed-in preview nor another creator's article
  // is this member's audience.
  await insertView(['pa-session-self', 'pa-visitor-self', profilePath, 'profile', profileId, owner, now]);
  await insertView(['pa-session-other', 'pa-visitor-other', 'article-other', 'article', otherArticle.rows[0].id, null, now]);

  const recent = await req('GET', '/profile-analytics/me/private?range=30', { token: tokenFor(owner) });
  assert.equal(recent.status, 200);
  assert.deepEqual(recent.body.audience, {
    profileViews: 2,
    profileVisitors: 1,
    articleReads: 2,
    articleReaders: 2,
  });
  assert.equal(recent.body.dailyAudience.length, 1);
  assert.equal(recent.body.dailyAudience[0].profile_views, 2);
  assert.equal(recent.body.dailyAudience[0].article_reads, 2);
  assert.deepEqual(recent.body.topArticles, [{
    articleId: article.rows[0].id,
    title: 'Owner story',
    reads: 2,
    readers: 2,
  }]);
  assert.match(recent.body.audienceNote, /analytics consent/i);
  assert.match(recent.body.audienceNote, /own signed-in views are excluded/i);

  const ninetyDays = await req('GET', '/profile-analytics/me/private?range=90', { token: tokenFor(owner) });
  assert.equal(ninetyDays.body.audience.articleReads, 3);
  assert.equal(ninetyDays.body.topArticles[0].reads, 3);
});
