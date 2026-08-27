// Site search, against a REAL PostgreSQL.
//
// What this protects:
//
//   1. RELEVANCE. The article actually called "Load Shedding" has to come
//      first for "load shedding" — not whichever piece mentioning it happens
//      to be newest. That was the old behaviour and it is the whole reason
//      for this change.
//   2. THE INDEX IS ACTUALLY USED. A Postgres expression index only applies
//      when the query spells the expression identically. Change search.js and
//      forget migration 150 and nothing appears broken: the same answers come
//      back, the site just starts reading every article body on every search.
//      Nothing but a test would ever tell us, so this one plans the real query
//      and fails if the index cannot serve it.
//   3. A STRANGER'S TYPING CANNOT 500 IT. to_tsquery throws on syntax it
//      dislikes. This endpoint is public and takes raw input.
//   4. SNIPPETS CARRY NO MARKUP. ts_headline does not escape what it is given,
//      so highlighting must never be handed to the client as HTML.
//   5. PRIVATE THINGS STAY PRIVATE. Pending articles and unpublished member
//      profiles are not search results.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-sitesearch-'));
const port = 42800 + (process.pid % 300); // bases are 400 apart so ranges cannot overlap

const migrationsDir = path.join(__dirname, '..', 'db', 'migrations');
const migrations = () => fs.readdirSync(migrationsDir).filter((x) => x.endsWith('.sql')).sort();

async function runMigrations() {
  for (const f of migrations()) {
    await pool.query(fs.readFileSync(path.join(migrationsDir, f), 'utf8'));
  }
}

async function search(qs) {
  const res = await fetch(baseUrl + '/search?' + qs);
  return { status: res.status, body: await res.json().catch(() => null) };
}

const titles = (body) => body.results.articles.map((a) => a.title);

// pg_trgm is a contrib extension. A real Postgres has it; the embedded build
// used by the tests does not, and migration 135 already documents the same
// gap. Anything trigram-shaped has to check rather than assume.
const hasTrgm = async () => {
  const r = await pool.query(`SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'`);
  return r.rows.length > 0;
};

before(async () => {
  // The embedded Postgres bundle ships without english.stop, which every
  // to_tsvector('english', ...) call needs. Must happen before the server
  // starts, and certainly before the migrations build the FTS indexes.
  // See test/helpers/textSearch.js for why this is a packaging gap in the
  // test dependency rather than a problem with the SQL.
  ensureStopWords();

  pg = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'postgres', password: 'postgres', port,
    persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('unplug_test');

  process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${port}/unplug_test`;
  process.env.JWT_SECRET = 'test-secret-for-sitesearch';
  process.env.UNPLUG_DISABLE_RATE_LIMITS = '1';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await runMigrations();

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/search', require('../src/routes/search'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await pool.query(`INSERT INTO users (id, email, full_name, password_hash, role)
                    VALUES (560001, 'search@test.com', 'Search Author', 'x', 'member')`);
  await pool.query(`INSERT INTO categories (id, name, type)
                    VALUES (9101, 'Energy', 'news'), (9102, 'Fashion', 'news')
                    ON CONFLICT (id) DO NOTHING`);

  const art = async (id, title, body, opts = {}) => pool.query(
    `INSERT INTO articles (id, author_user_id, category_id, title, body, status, published_at, tags, subtitle)
     VALUES ($1, 560001, $2, $3, $4, $5, $6, $7, $8)`,
    [id, opts.category || 9101, title, body, opts.status || 'approved',
     opts.published || '2026-01-15T00:00:00Z', opts.tags || null, opts.subtitle || null]
  );

  // The ranking fixture. The body-only mention is DELIBERATELY the newest —
  // under the old date ordering it came first, which is the bug.
  await art(9001, 'Load Shedding Explained', 'A guide to the national grid.', { published: '2026-01-01T00:00:00Z' });
  await art(9002, 'A Day in Soweto', 'They spoke about load shedding once, briefly, near the end.', { published: '2026-06-01T00:00:00Z' });

  // Stemming.
  await art(9003, 'She Runs at Dawn', 'Every morning without fail.', { published: '2026-02-01T00:00:00Z' });

  // Tag-only: the word never appears in the text.
  await art(9004, 'Threads of Joburg', 'A quiet piece about a tailor.', { tags: ['Fashion'], published: '2026-03-01T00:00:00Z' });

  // Typo target and category/date filter fixtures.
  await art(9005, 'Fashion Week Comes Home', 'Designers gathered in Cape Town.',
    { category: 9102, published: '2026-04-01T00:00:00Z' });

  // Must never be returned.
  await art(9006, 'Load Shedding Secrets', 'Not approved yet.', { status: 'pending' });

  // Snippet safety: real article bodies can contain markup.
  await art(9007, 'Markup In The Body',
    'Before the match <script>alert(1)</script> and the word zebracrossing appears here.',
    { published: '2026-05-01T00:00:00Z' });

  await pool.query(
    `INSERT INTO profiles (id, user_id, type, category_id, package_tier, slug, display_name, bio, status)
     VALUES (9201, 560001, 'business', 9102, 'basic', 'thato-tailoring', 'Thato Tailoring',
             'Bespoke suits and load shedding proof lighting.', 'approved')`
  );
  await pool.query(
    `INSERT INTO my_unplug_profiles (user_id, username, display_name, about_me, is_published)
     VALUES (560001, 'searchfan', 'Search Fan', 'I love load shedding trivia.', false)`
  );
  await pool.query(
    `INSERT INTO editions (issue_number, title, pdf_url) VALUES (9301, 'Load Shedding Special', 'x.pdf')`
  );
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
});

test('RELEVANCE: the article titled for the term beats a newer body-only mention', async () => {
  const { status, body } = await search('q=load+shedding');
  assert.equal(status, 200);
  const order = titles(body);
  assert.ok(order.includes('Load Shedding Explained'), 'the titled article is in the results');
  assert.equal(order[0], 'Load Shedding Explained',
    'title match must outrank a body mention — this is the entire point of the change');
  assert.ok(order.indexOf('A Day in Soweto') > 0, 'the newer body-only mention comes after it');
});

test('THE FTS INDEX CAN ACTUALLY SERVE THE QUERY', async () => {
  // With seven rows Postgres will always choose a sequential scan, so turn
  // that option off and ask it to plan the real query. If search.js and
  // migration 150 have drifted apart the planner cannot use the index and
  // this fails — which is the only way anybody would ever find out.
  const { FTS } = require('../src/routes/search');
  const client = await pool.connect();
  try {
    await client.query('SET enable_seqscan = off');
    // Only the tsvector condition. With `status = 'approved'` in there too the
    // planner picks idx_articles_status and applies the tsvector as a filter —
    // a perfectly sensible choice on seven rows, but it tells us nothing about
    // whether the FTS index is reachable, which is the thing being tested.
    const plan = await client.query(
      `EXPLAIN (FORMAT JSON)
       SELECT id FROM articles
        WHERE ${FTS.articles} @@ websearch_to_tsquery('english', 'load shedding')`
    );
    const text = JSON.stringify(plan.rows[0]['QUERY PLAN']);
    assert.ok(text.includes('idx_articles_fts'),
      'the planner did not reach idx_articles_fts — the expression in search.js no longer matches migration 150:\n' + text);
  } finally {
    await client.query('RESET enable_seqscan');
    client.release();
  }
});

test('the expression in search.js is the one migration 150 indexed', async () => {
  // Belt and braces next to the EXPLAIN above, but it names the problem
  // directly instead of leaving somebody to read a query plan.
  const { FTS } = require('../src/routes/search');
  const sql = fs.readFileSync(path.join(migrationsDir, '150_search_ranking.sql'), 'utf8');
  const flat = (s) => s.replace(/\s+/g, ' ').trim();
  for (const [name, expr] of Object.entries(FTS)) {
    assert.ok(flat(sql).includes(flat(expr)),
      `FTS.${name} is not indexed by migration 150 — searches would silently start scanning`);
  }
});

test('STEMMING: "running" finds "Runs"', async () => {
  const { body } = await search('q=running');
  assert.ok(titles(body).includes('She Runs at Dawn'),
    'full-text search stems, which is why it was worth having');
});

test("A STRANGER'S TYPING CANNOT 500 IT", async () => {
  // to_tsquery throws on all of these. websearch_to_tsquery does not.
  for (const q of ['C++ & | !', '"unclosed quote', '!!!', 'a & b |', '<>&;--', 'load OR']) {
    const { status } = await search('q=' + encodeURIComponent(q));
    assert.equal(status, 200, `"${q}" must not error`);
  }
});

test('quoted phrases are honoured', async () => {
  const { body } = await search('q=' + encodeURIComponent('"load shedding"'));
  assert.ok(titles(body).length > 0, 'a quoted phrase still searches');
});

test('a tag-only match is found, and ranks below a real text match', async () => {
  const { body } = await search('q=fashion');
  const order = titles(body);
  assert.ok(order.includes('Threads of Joburg'), 'the tag makes it findable');
  assert.ok(order.includes('Fashion Week Comes Home'));
  assert.ok(order.indexOf('Fashion Week Comes Home') < order.indexOf('Threads of Joburg'),
    'the piece that says the word beats the piece that was merely tagged with it');
});

test('SNIPPETS CARRY NO MARKUP', async () => {
  const { body } = await search('q=zebracrossing');
  const hit = body.results.articles.find((a) => a.title === 'Markup In The Body');
  assert.ok(hit, 'found the article');
  assert.ok(!/<mark>/.test(hit.snippet), 'highlighting is not sent as HTML');
  assert.ok(hit.snippet.includes('') && hit.snippet.includes(''),
    'highlighting is marked with control characters the client swaps for <mark> after escaping');
  // Postgres's text search parser recognises HTML tags as tokens and
  // ts_headline drops them, so `<script>` does not survive into the snippet —
  // only its inner text does. That is a useful second line of defence, not the
  // first one: the control-character scheme above is what actually guarantees
  // the client never receives markup it is expected to trust.
  assert.ok(!hit.snippet.includes('<'), 'no angle bracket survives into a snippet');
  assert.ok(hit.snippet.includes('zebracrossing'), 'the matched word is in the fragment');
});

test('PENDING ARTICLES ARE NOT SEARCH RESULTS', async () => {
  const { body } = await search('q=load+shedding');
  assert.ok(!titles(body).includes('Load Shedding Secrets'));
});

test('AN UNPUBLISHED MEMBER PROFILE IS NOT A SEARCH RESULT', async () => {
  const { body } = await search('q=load+shedding');
  assert.deepEqual(body.results.members, [], 'is_published = false stays private');
});

test('approved profiles and editions are still searched', async () => {
  const { body } = await search('q=load+shedding');
  assert.ok(body.results.profiles.some((p) => p.display_name === 'Thato Tailoring'));
  assert.ok(body.results.editions.some((e) => e.title === 'Load Shedding Special'));
});

test('DID YOU MEAN: a typo is answered instead of a blank page', async (t) => {
  const { body } = await search('q=fashon');
  assert.equal(body.totals.articles, 0, 'the typo genuinely matches nothing');

  // pg_trgm is NOT available in the embedded-postgres build the tests run
  // against — the same limitation migration 135 already documents. Suggestions
  // are a trigram feature, so this cannot be exercised here.
  //
  // What IS asserted below either way is the part that matters more: the
  // absence of the extension must degrade to "no suggestion", never to a 500.
  if (!(await hasTrgm())) {
    t.diagnostic('pg_trgm unavailable in this Postgres — suggestion quality not exercised');
    assert.equal(body.suggestion, null, 'degrades to no suggestion rather than erroring');
    return;
  }
  assert.ok(body.suggestion, 'a suggestion is offered rather than an empty result');
  assert.match(body.suggestion, /Fashion/i);
});

test('A MISSING pg_trgm CANNOT TURN A SEARCH INTO A 500', async () => {
  // The suggestion query calls word_similarity(), which does not exist without
  // the extension. That must be swallowed: a search that found nothing is a
  // normal outcome, and losing a nicety must not lose the response.
  const { status, body } = await search('q=' + encodeURIComponent('qwertyuiopzxcv'));
  assert.equal(status, 200);
  assert.equal(body.totals.articles, 0);
  assert.ok('suggestion' in body, 'the key is always present, even when null');
});

test('no suggestion is offered when there were results', async () => {
  const { body } = await search('q=fashion');
  assert.equal(body.suggestion, null, 'suggesting an alternative to a successful search is noise');
});

test('totals are the whole match count, not the page', async () => {
  const { body } = await search('q=' + encodeURIComponent('load shedding') + '&type=articles&limit=1&page=1');
  assert.equal(body.results.articles.length, 1, 'one row on the page');
  assert.ok(body.totals.articles >= 2, 'but the total counts every match');
});

test('pagination returns different rows on page 2', async () => {
  const one = await search('q=' + encodeURIComponent('load shedding') + '&type=articles&limit=1&page=1');
  const two = await search('q=' + encodeURIComponent('load shedding') + '&type=articles&limit=1&page=2');
  assert.notEqual(one.body.results.articles[0].id, two.body.results.articles[0].id);
});

test('asking for one type does not run the other three', async () => {
  const { body } = await search('q=load+shedding&type=articles');
  assert.deepEqual(body.results.profiles, []);
  assert.deepEqual(body.results.editions, []);
  assert.equal(body.totals.profiles, 0);
});

test('the category filter narrows articles', async () => {
  const all = await search('q=fashion');
  const narrowed = await search('q=fashion&category=9102');
  assert.ok(titles(all.body).includes('Threads of Joburg'), 'unfiltered includes the Energy-category piece');
  assert.ok(!titles(narrowed.body).includes('Threads of Joburg'), 'filtered to Fashion, it is gone');
  assert.ok(titles(narrowed.body).includes('Fashion Week Comes Home'));
});

test('the date filter narrows articles', async () => {
  const { body } = await search('q=load+shedding&from=2026-03-01');
  assert.ok(!titles(body).includes('Load Shedding Explained'), 'published January, before the window');
  assert.ok(titles(body).includes('A Day in Soweto'), 'published June, inside it');
});

test('AN UNPARSEABLE DATE IS IGNORED, NOT AN ERROR', async () => {
  // Somebody opening a shared search URL should get results, not a complaint
  // about a query string they never typed.
  const { status, body } = await search('q=load+shedding&from=not-a-date&to=whenever');
  assert.equal(status, 200);
  assert.ok(body.totals.articles > 0);
});

test('limit is capped so nobody can ask for the whole database', async () => {
  const { body } = await search('q=load+shedding&type=articles&limit=100000');
  assert.ok(body.limit <= 24, 'limit was clamped, got ' + body.limit);
});

test('a one-letter query returns the empty shape, not an error', async () => {
  const { status, body } = await search('q=a');
  assert.equal(status, 200);
  assert.deepEqual(body.results, { articles: [], profiles: [], editions: [], members: [] });
  assert.equal(body.suggestion, null);
});

test('the old response shape is intact', async () => {
  // The search overlay on the magazine reads exactly these keys. Adding to
  // the response is fine; moving anything is not.
  const { body } = await search('q=load+shedding');
  assert.deepEqual(Object.keys(body.results).sort(), ['articles', 'editions', 'members', 'profiles']);
  assert.ok(typeof body.query === 'string');
});

test('re-running every migration is idempotent and the indexes survive', async (t) => {
  await runMigrations();
  const names = async (list) => (await pool.query(
    `SELECT indexname FROM pg_indexes WHERE indexname = ANY($1)`, [list])).rows.map((r) => r.indexname);

  // The full-text indexes do not depend on any extension, so these must exist
  // wherever the migration ran at all.
  assert.deepEqual(
    (await names(['idx_articles_fts', 'idx_profiles_fts', 'idx_my_unplug_fts'])).sort(),
    ['idx_articles_fts', 'idx_my_unplug_fts', 'idx_profiles_fts'],
    'the FTS indexes survive a migration re-run');

  if (!(await hasTrgm())) {
    t.diagnostic('pg_trgm unavailable — trigram indexes correctly skipped rather than failing the migration');
    assert.deepEqual(await names(['idx_articles_title_trgm']), [],
      'no half-made trigram index is left behind');
    return;
  }
  assert.deepEqual(await names(['idx_articles_title_trgm']), ['idx_articles_title_trgm']);
});

test('A MIGRATION MUST NEVER FAIL OVER A MISSING EXTENSION', async () => {
  // `npm start` is `migrate && node src/app.js`, so a migration that throws is
  // not a degraded feature — it is the API never starting. Every migration
  // here re-runs on every deploy, which means one unavailable extension would
  // take the site down for ever. Re-running the whole set must stay clean.
  await assert.doesNotReject(() => runMigrations(),
    'migration 150 must survive a Postgres without pg_trgm');
});
