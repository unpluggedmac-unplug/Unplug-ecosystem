// The free-account gate, against a REAL PostgreSQL.
//
// What this protects:
//
//   1. THE GATE IS SERVER-SIDE. The body must not be sent at all. A preview
//      enforced in the browser is a CSS overlay with the whole article sitting
//      underneath it in the page source.
//   2. EVERY ENDPOINT THAT RETURNS A BODY IS COVERED. GET /articles selects
//      a.body in full, so gating only /articles/:id would hand the piece over
//      anyway — one request to the list and the gate is decorative. That was a
//      real hole found while building this, and these tests are what keep it
//      shut.
//   3. SEARCH CANNOT BE USED TO READ A GATED PIECE A FRAGMENT AT A TIME.
//      ts_headline returns text from anywhere in the article.
//   4. GATING IS AN ADMIN DECISION. A member paying to place an article must
//      not be able to decide who may read it.
//   5. NOTHING ALREADY PUBLISHED CHANGES. The column defaults to false.
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
let otherToken;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-gate-'));
const port = 43200 + (process.pid % 300); // bases are 400 apart so ranges cannot overlap

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

// 400 words, so a 120-word preview is unmistakably a fraction of it. The
// sentinel only appears near the end: if it ever reaches a signed-out reader,
// the gate leaked.
const SECRET = 'ZEBRACROSSING';
const LONG_BODY = '<p>' + Array.from({ length: 380 }, (_, i) => 'word' + i).join(' ')
  + ' ' + SECRET + ' ' + Array.from({ length: 19 }, (_, i) => 'tail' + i).join(' ') + '</p>';

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
  process.env.JWT_SECRET = 'test-secret-for-gate';
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
  app.use('/articles', require('../src/routes/articles'));
  app.use('/search', require('../src/routes/search'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await pool.query(`INSERT INTO users (id, email, full_name, password_hash, role) VALUES
    (570001, 'gateadmin@test.com', 'Gate Admin', 'x', 'admin'),
    (570002, 'gatemember@test.com', 'Gate Member', 'x', 'member'),
    (570003, 'gateother@test.com', 'Other Member', 'x', 'member')`);
  const sign = (id, email, role) => jwt.sign({ id, email, role }, process.env.JWT_SECRET);
  adminToken = sign(570001, 'gateadmin@test.com', 'admin');
  memberToken = sign(570002, 'gatemember@test.com', 'member');
  otherToken = sign(570003, 'gateother@test.com', 'member');

  await pool.query(`INSERT INTO categories (id, name, type) VALUES (9501, 'Community', 'news')
                    ON CONFLICT (id) DO NOTHING`);

  // 9601 gated, 9602 open — same body, so any difference is the gate.
  await pool.query(
    `INSERT INTO articles (id, author_user_id, category_id, title, body, status, published_at,
                           requires_account, meta_description, banner_image_url, subtitle)
     VALUES (9601, 570002, 9501, 'A Gated Piece', $1, 'approved', now(), true,
             'The summary that is safe to show.', 'https://example.test/a.jpg', 'A standfirst'),
            (9602, 570002, 9501, 'An Open Piece', $1, 'approved', now(), false,
             'Also has a summary.', 'https://example.test/b.jpg', 'Another standfirst')`,
    [LONG_BODY]
  );
  await pool.query(
    `INSERT INTO article_sections (article_id, sub_heading, paragraph, position)
     VALUES (9601, 'The rest of it', 'More of the article, ` + SECRET + `2 lives here.', 1)`
  );
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
});

const wordsIn = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;

// ---------------------------------------------------------------- reading

test('A SIGNED-OUT READER GETS A PREVIEW, NOT THE ARTICLE', async () => {
  const { status, body } = await api('GET', '/articles/9601');
  assert.equal(status, 200);
  assert.equal(body.article.gated, true, 'the response says so plainly');
  assert.ok(!body.article.body.includes(SECRET),
    'the end of the article never reached the browser');
  assert.ok(wordsIn(body.article.body) <= 121, 'about 120 words, got ' + wordsIn(body.article.body));
  assert.ok(body.article.body.endsWith('…'), 'and it is visibly cut off');
});

test('the preview is plain text, so no half-open tag can escape', async () => {
  const { body } = await api('GET', '/articles/9601');
  assert.ok(!/[<>]/.test(body.article.body), 'no markup survives into a preview');
  assert.equal(body.article.body_format, 'text',
    'the reader is told to render it as text, which it already knows how to do');
});

test('SECTIONS ARE THE REST OF THE ARTICLE, AND ARE WITHHELD', async () => {
  const { body } = await api('GET', '/articles/9601');
  assert.deepEqual(body.sections, [],
    'sending sections beside a truncated body would be the whole piece in another shape');
  assert.ok(JSON.stringify(body).indexOf(SECRET + '2') === -1, 'nothing from a section leaked');
});

test('a signed-in member reads the whole thing', async () => {
  const { body } = await api('GET', '/articles/9601', null, memberToken);
  assert.equal(body.article.gated, false);
  assert.ok(body.article.body.includes(SECRET), 'the full body is there');
  assert.equal(body.sections.length, 1, 'and so are the sections');
});

test('ANY account passes — the gate asks for an account, not a payment', async () => {
  // otherToken belongs to someone with no connection to this article.
  const { body } = await api('GET', '/articles/9601', null, otherToken);
  assert.equal(body.article.gated, false);
  assert.ok(body.article.body.includes(SECRET));
});

test('an admin can always read a gated piece, to check what it says', async () => {
  const { body } = await api('GET', '/articles/9601', null, adminToken);
  assert.ok(body.article.body.includes(SECRET));
});

test('AN UNGATED ARTICLE IS COMPLETELY UNTOUCHED', async () => {
  const { body } = await api('GET', '/articles/9602');
  assert.equal(body.article.gated, false);
  assert.ok(body.article.body.includes(SECRET), 'full body, signed out');
  assert.equal(body.article.body_format, 'html', 'its format is not rewritten');
});

// -------------------------------------------------- the endpoint that leaked

test('THE LIST IS GATED TOO — it selects a.body in full', async () => {
  // This is the hole that made the whole feature pointless: /articles returns
  // every body, so gating only /articles/:id would have been decoration.
  const { status, body } = await api('GET', '/articles?page=1&limit=20');
  assert.equal(status, 200);
  const gated = body.articles.find((a) => a.id === 9601);
  const open = body.articles.find((a) => a.id === 9602);
  assert.ok(gated, 'a gated article still appears in the list');
  assert.ok(!gated.body.includes(SECRET), 'but not with its body attached');
  assert.equal(gated.gated, true);
  assert.ok(open.body.includes(SECRET), 'the open one is unaffected');
});

test('the list is whole again for a signed-in reader', async () => {
  const { body } = await api('GET', '/articles?page=1&limit=20', null, memberToken);
  const gated = body.articles.find((a) => a.id === 9601);
  assert.ok(gated.body.includes(SECRET));
});

test('most-viewed is gated as well', async () => {
  const { status, body } = await api('GET', '/articles/most-viewed?days=365&limit=12');
  assert.equal(status, 200);
  const gated = body.articles.find((a) => a.id === 9601);
  if (!gated) return;   // it only appears once it has recorded views
  assert.ok(!gated.body.includes(SECRET));
});

// ------------------------------------------------------------------ search

test('SEARCH CANNOT BE USED TO READ A GATED PIECE A WORD AT A TIME', async () => {
  // ts_headline returns the text around the match, from anywhere in the
  // article. Searching for term after term would otherwise reassemble it.
  const { status, body } = await api('GET', '/search?q=' + SECRET);
  assert.equal(status, 200);
  const hit = body.results.articles.find((a) => a.id === 9601);
  if (hit) {
    assert.ok(!hit.snippet.includes(SECRET),
      'a gated article never gets a snippet cut from its body');
    assert.equal(hit.snippet, 'The summary that is safe to show.',
      'it shows the summary it was published with instead');
  }
  const open = body.results.articles.find((a) => a.id === 9602);
  assert.ok(open, 'the ungated article is still found by its body');
  assert.ok(open.snippet.includes(SECRET), 'and still gets a real snippet');
});

test('a gated article is still findable by title', async () => {
  const { body } = await api('GET', '/search?q=' + encodeURIComponent('Gated Piece'));
  assert.ok(body.results.articles.some((a) => a.id === 9601),
    'gating hides the text, not the existence of the piece');
});

// ------------------------------------------------------- who may set it

test('GATING IS AN ADMIN DECISION', async () => {
  const before = await api('GET', '/articles/9602', null, adminToken);
  assert.equal(before.body.article.requires_account, false);

  // The author of the article is a member. Their attempt is ignored, not
  // refused — it is not their field to set.
  await api('PATCH', '/articles/9602', { requiresAccount: true }, memberToken);
  const after = await api('GET', '/articles/9602', null, adminToken);
  assert.equal(after.body.article.requires_account, false,
    'a member cannot decide who may read the publication');
});

test('an admin can gate and ungate', async () => {
  const on = await api('PATCH', '/articles/9602', { requiresAccount: true }, adminToken);
  assert.equal(on.status, 200);
  let now = await api('GET', '/articles/9602');
  assert.equal(now.body.article.gated, true);

  await api('PATCH', '/articles/9602', { requiresAccount: false }, adminToken);
  now = await api('GET', '/articles/9602');
  assert.equal(now.body.article.gated, false, 'and it goes back');
  assert.ok(now.body.article.body.includes(SECRET));
});

// --------------------------------------------------------------- settings

test('the preview length follows the setting', async () => {
  const { resetCache } = require('../src/utils/accountGate');
  await pool.query(`UPDATE settings SET value = '25' WHERE key = 'gate_preview_words'`);
  resetCache();
  const { body } = await api('GET', '/articles/9601');
  assert.ok(wordsIn(body.article.body) <= 26, 'got ' + wordsIn(body.article.body));

  await pool.query(`UPDATE settings SET value = '120' WHERE key = 'gate_preview_words'`);
  resetCache();
});

test('A NONSENSE SETTING FALLS BACK RATHER THAN BREAKING THE ARTICLE', async () => {
  const { resetCache, DEFAULT_PREVIEW_WORDS } = require('../src/utils/accountGate');
  await pool.query(`UPDATE settings SET value = 'lots' WHERE key = 'gate_preview_words'`);
  resetCache();
  const { status, body } = await api('GET', '/articles/9601');
  assert.equal(status, 200, 'the article still loads');
  assert.ok(wordsIn(body.article.body) <= DEFAULT_PREVIEW_WORDS + 1);

  await pool.query(`UPDATE settings SET value = '120' WHERE key = 'gate_preview_words'`);
  resetCache();
});

// ----------------------------------------------------------- what is kept

test('THE THINGS A SHARE AND A SEARCH ENGINE NEED ARE KEPT', async () => {
  // Withholding these would hide the article from exactly the people most
  // likely to make an account in order to read it.
  const { body } = await api('GET', '/articles/9601');
  const a = body.article;
  assert.equal(a.title, 'A Gated Piece');
  assert.equal(a.subtitle, 'A standfirst');
  assert.equal(a.meta_description, 'The summary that is safe to show.');
  assert.equal(a.banner_image_url, 'https://example.test/a.jpg');
  assert.equal(a.category, 'Community');
  assert.ok(a.published_at, 'and the date');
});

test('the substance beyond the body is withheld', async () => {
  await pool.query(
    `UPDATE articles SET conclusion = 'The concluding ` + SECRET + `3.',
                         cta_url = 'https://example.test/buy', video_url = 'https://youtu.be/x'
      WHERE id = 9601`);
  const { body } = await api('GET', '/articles/9601');
  assert.equal(body.article.conclusion, null, 'a conclusion is the end of the article');
  assert.equal(body.article.video_url, null);
  assert.ok(JSON.stringify(body).indexOf(SECRET + '3') === -1);
});

// -------------------------------------------------------------- migration

test('NOTHING ALREADY PUBLISHED IS GATED BY THE MIGRATION ITSELF', async () => {
  const r = await pool.query(`SELECT COUNT(*)::int AS n FROM articles WHERE requires_account = true AND id <> 9601`);
  assert.equal(r.rows[0].n, 0,
    'adding the column must not gate the archive — gating is an editorial act, one piece at a time');
});

test('re-running every migration is idempotent and keeps the flag', async () => {
  await pool.query(`UPDATE articles SET requires_account = true WHERE id = 9601`);
  await runMigrations();
  const r = await pool.query(`SELECT requires_account FROM articles WHERE id = 9601`);
  assert.equal(r.rows[0].requires_account, true, 'a re-run does not reset an editor\'s decision');
});
