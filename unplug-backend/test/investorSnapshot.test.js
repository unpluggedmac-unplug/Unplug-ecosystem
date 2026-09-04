// INV-001: the Investors page had no evidence dashboard at all — real
// figures exist (GA4, analytics_sessions, users, articles, votes) but were
// never surfaced there. Asked first whether commercial/revenue figures
// belonged on a page anyone can open; the answer was no — real investors
// get that in conversation, not published to the world. This is the
// audience/community/content half only, sourced from real tables the same
// way the homepage stats and advertiser media kit already are.
//
// Website remediation punch-list (2026-09-03), INV-001.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-invsnap-'));
const port = 64000 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

function migrationFiles() {
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
    .map((f) => path.join(dir, f));
}

async function req(urlPath) {
  const res = await fetch(baseUrl + urlPath);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
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
  process.env.JWT_SECRET = 'test-secret-for-invsnap';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const file of migrationFiles()) {
    await pool.query(fs.readFileSync(file, 'utf8'));
  }

  // --- seed real rows across every table the snapshot draws from ---
  const author = await pool.query(
    `INSERT INTO users (email, password_hash, role) VALUES ('invsnap-author@test.com', 'x', 'member') RETURNING id`
  );
  const authorId = author.rows[0].id;

  await pool.query(`INSERT INTO articles (author_user_id, title, body, status) VALUES ($1, 'A', 'body', 'approved')`, [authorId]);
  await pool.query(`INSERT INTO articles (author_user_id, title, body, status) VALUES ($1, 'B', 'body', 'pending')`, [authorId]); // must NOT be counted

  const profile = await pool.query(
    `INSERT INTO profiles (user_id, type, package_tier, slug, display_name, status)
     VALUES ($1, 'individual', 'basic', 'invsnap-profile', 'Snap Profile', 'approved') RETURNING id`,
    [authorId]
  );
  const profileId = profile.rows[0].id;

  await pool.query(`INSERT INTO gallery_images (owner_type, image_url, status) VALUES ('general', 'https://x.com/a.jpg', 'approved')`);
  await pool.query(`INSERT INTO gallery_images (owner_type, image_url, status) VALUES ('general', 'https://x.com/b.jpg', 'pending')`); // must NOT be counted

  await pool.query(`INSERT INTO editions (issue_number, title, pdf_url) VALUES (1, 'Issue One', 'https://x.com/1.pdf')`);

  const comp = await pool.query(
    `INSERT INTO competitions (name, slug, opens_at, closes_at, status)
     VALUES ('Snap Comp', 'snap-comp', now(), now() + interval '30 days', 'open') RETURNING id`
  );
  const entry = await pool.query(
    `INSERT INTO competition_entries (competition_id, profile_id, status) VALUES ($1, $2, 'approved') RETURNING id`,
    [comp.rows[0].id, profileId]
  );
  await pool.query(`INSERT INTO votes (entry_id, session_id) VALUES ($1, 'sess-a')`, [entry.rows[0].id]);
  await pool.query(`INSERT INTO votes (entry_id, session_id) VALUES ($1, 'sess-b')`, [entry.rows[0].id]);

  // Two analytics sessions in the last 30 days (readers = 2 distinct visitors)
  await pool.query(
    `INSERT INTO analytics_sessions (session_id, visitor_id, page_count, started_at)
     VALUES ('s1', 'v1', 3, now() - interval '2 days'), ('s2', 'v2', 5, now() - interval '3 days')`
  );

  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/analytics', require('../src/routes/analytics'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}, { timeout: 120000 });

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('AUDIENCE FIGURES COUNT ONLY REAL SESSIONS IN THE LAST 30 DAYS', async () => {
  const { status, body } = await req('/analytics/investor-snapshot');
  assert.equal(status, 200);
  assert.equal(body.audience.readers, 2);
  assert.equal(body.audience.pageViews, 8);
});

test('READER GROWTH IS null, NOT 0%, WHEN THERE IS NO PRIOR-WINDOW HISTORY TO COMPARE AGAINST', async () => {
  const { body } = await req('/analytics/investor-snapshot');
  assert.equal(body.audience.readerGrowthPct, null,
    'no sessions exist in the 30-60-day-ago window in this test, so growth must not be reported as a fake 0%');
});

test('CONTENT COUNTS ONLY APPROVED ROWS — A PENDING ARTICLE OR PHOTO IS NOT PUBLIC EVIDENCE', async () => {
  const { body } = await req('/analytics/investor-snapshot');
  assert.equal(body.content.articlesPublished, 1);
  assert.equal(body.content.galleryImages, 1);
  assert.equal(body.content.editionsPublished, 1);
});

test('COMMUNITY FIGURES ARE REAL COUNTS, INCLUDING VOTES ACTUALLY CAST', async () => {
  const { body } = await req('/analytics/investor-snapshot');
  assert.equal(body.community.votesCast, 2);
  assert.ok(body.community.registeredMembers >= 1);
  assert.equal(body.community.directoryProfiles, 1);
});

test('NO REVENUE OR PAYMENT FIGURE APPEARS ANYWHERE IN THE RESPONSE — asked, and the answer was to leave it out', async () => {
  const { body } = await req('/analytics/investor-snapshot');
  const flat = JSON.stringify(body).toLowerCase();
  assert.ok(!flat.includes('revenue'), 'the response must never mention revenue');
  assert.ok(!flat.includes('payment'), 'the response must never mention payments');
});
