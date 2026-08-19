// TAGS on articles, Directory listings and My Unplug profiles.
//
// Four different people write these — an editor, a business owning a listing,
// a member owning a profile, and the backfill — across three tables. The
// guarantees worth pinning are the ones that quietly stop being true when one
// of those four paths is changed without the others:
//
//   1. TEN IS THE LIMIT, and the DATABASE enforces it. A cap that lives only
//      in a route is a cap the next route forgets.
//   2. The same tag twice, in any casing, is one tag. Otherwise "Fashion" and
//      "fashion" become two subjects and the topic reports split their numbers
//      between them without anyone noticing.
//   3. Search actually finds them. A tag nobody can search for is decoration.
//   4. A member profile is searchable ONLY once published — a search result is
//      a public page.
//   5. The backfill NEVER overwrites a tag a person chose.
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

let pg;
let pool;
let server;
let baseUrl;
let jwt;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-tags-'));
const port = 28800 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

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
  return jwt.sign({ id: userId, email: `tg${userId}@test.com`, role }, process.env.JWT_SECRET);
}

let _nextUserId = 221000;
let _slug = 0;
async function makeUser(role = 'member') {
  const id = _nextUserId++;
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', $3) ON CONFLICT DO NOTHING`,
    [id, `tg${id}@test.com`, role]
  );
  return id;
}

async function makeListing(userId, name, bio) {
  const r = await pool.query(
    `INSERT INTO profiles (user_id, type, package_tier, slug, display_name, bio, status)
     VALUES ($1, 'business', 'basic', $2, $3, $4, 'approved') RETURNING id`,
    [userId, `tag-listing-${_slug++}`, name, bio || null]
  );
  return r.rows[0].id;
}

let adminId;
let adminToken;

before(async () => {
  pg = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'postgres', password: 'postgres', port,
    persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('unplug_test');

  process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${port}/unplug_test`;
  process.env.JWT_SECRET = 'test-secret-for-tags';
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
  app.use('/', require('../src/routes/profiles'));
  app.use('/articles', require('../src/routes/articles'));
  app.use('/my-unplug', require('../src/routes/myUnplug'));
  app.use('/search', require('../src/routes/search'));
  app.use('/admin/tags', require('../src/routes/adminTags'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  adminId = await makeUser('admin');
  adminToken = tokenFor(adminId, 'admin');
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  if (pg) await pg.stop();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* Windows holds the dir briefly */ }
});

// ---------------------------------------------------------------------------
// The ten-tag ceiling
// ---------------------------------------------------------------------------

test('THE DATABASE REFUSES AN ELEVENTH TAG, whatever the route does', async () => {
  // The limit is enforced in SQL precisely so that a new write path cannot
  // quietly exceed it. This bypasses every route to prove it.
  const userId = await makeUser();
  const id = await makeListing(userId, 'Cap Test');
  const eleven = Array.from({ length: 11 }, (_, i) => 'tag' + i);

  await assert.rejects(
    () => pool.query('UPDATE profiles SET tags = $1 WHERE id = $2', [eleven, id]),
    /tags_max/,
    'eleven tags must be impossible at the storage layer'
  );

  const ten = Array.from({ length: 10 }, (_, i) => 'tag' + i);
  await pool.query('UPDATE profiles SET tags = $1 WHERE id = $2', [ten, id]);
  const row = await pool.query('SELECT cardinality(tags) AS n FROM profiles WHERE id = $1', [id]);
  assert.equal(row.rows[0].n, 10, 'ten is allowed');
});

test('sending more than ten keeps the first ten rather than failing the save', async () => {
  // Somebody typing twelve tags meant to tag their listing. Losing their whole
  // edit over the eleventh would be a worse answer than keeping ten.
  const userId = await makeUser();
  const id = await makeListing(userId, 'Truncate Test');
  const res = await req('PATCH', `/profiles/${id}`, {
    token: tokenFor(userId),
    body: { tags: Array.from({ length: 14 }, (_, i) => 'many' + i) },
  });
  assert.equal(res.status, 200);
  const row = await pool.query('SELECT tags FROM profiles WHERE id = $1', [id]);
  assert.equal(row.rows[0].tags.length, 10);
  assert.equal(row.rows[0].tags[0], 'many0', 'the first ten, in the order given');
});

test('the same tag in different casing is ONE tag', async () => {
  const userId = await makeUser();
  const id = await makeListing(userId, 'Dupe Test');
  await req('PATCH', `/profiles/${id}`, {
    token: tokenFor(userId),
    body: { tags: ['Fashion', 'fashion', 'FASHION', '  Fashion  ', 'Style'] },
  });
  const row = await pool.query('SELECT tags FROM profiles WHERE id = $1', [id]);
  assert.deepEqual(row.rows[0].tags, ['Fashion', 'Style'],
    'otherwise one subject becomes several and the topic reports split between them');
});

test('a comma-separated string is accepted, the way a text box produces it', async () => {
  const userId = await makeUser();
  const id = await makeListing(userId, 'String Test');
  await req('PATCH', `/profiles/${id}`, {
    token: tokenFor(userId), body: { tags: 'Coffee, Roastery , Cape Town' },
  });
  const row = await pool.query('SELECT tags FROM profiles WHERE id = $1', [id]);
  assert.deepEqual(row.rows[0].tags, ['Coffee', 'Roastery', 'Cape Town']);
});

// ---------------------------------------------------------------------------
// Who may tag what
// ---------------------------------------------------------------------------

test('an owner tags their own listing; a stranger cannot', async () => {
  const owner = await makeUser();
  const stranger = await makeUser();
  const id = await makeListing(owner, 'Ownership Test');

  assert.equal((await req('PATCH', `/profiles/${id}`, {
    token: tokenFor(owner), body: { tags: ['Mine'] },
  })).status, 200);

  const denied = await req('PATCH', `/profiles/${id}`, {
    token: tokenFor(stranger), body: { tags: ['Theirs'] },
  });
  assert.ok(denied.status === 403 || denied.status === 404, 'somebody else must not retag a listing');

  const row = await pool.query('SELECT tags FROM profiles WHERE id = $1', [id]);
  assert.deepEqual(row.rows[0].tags, ['Mine']);
});

test('an admin can tag anyone\'s listing', async () => {
  const owner = await makeUser();
  const id = await makeListing(owner, 'Admin Edit Test');
  const res = await req('PATCH', `/profiles/${id}`, {
    token: adminToken, body: { tags: ['Edited By Admin'] },
  });
  assert.equal(res.status, 200);
});

test('a member tags their own My Unplug profile', async () => {
  const userId = await makeUser();
  const res = await req('PUT', '/my-unplug/me', {
    token: tokenFor(userId),
    body: { username: 'tagger' + userId, displayName: 'Tagger', tags: ['Poetry', 'Deaf Culture'] },
  });
  assert.equal(res.status, 200);
  const row = await pool.query('SELECT tags FROM my_unplug_profiles WHERE user_id = $1', [userId]);
  assert.deepEqual(row.rows[0].tags, ['Poetry', 'Deaf Culture']);
});

test('saving a My Unplug profile WITHOUT tags does not wipe them', async () => {
  // This route saves the whole profile. An older screen that does not know
  // about tags would otherwise clear them every time somebody edited their bio.
  const userId = await makeUser();
  const token = tokenFor(userId);
  await req('PUT', '/my-unplug/me', {
    token, body: { username: 'keep' + userId, displayName: 'Keeper', tags: ['Music'] },
  });
  await req('PUT', '/my-unplug/me', {
    token, body: { username: 'keep' + userId, displayName: 'Keeper Renamed' },
  });
  const row = await pool.query('SELECT tags, display_name FROM my_unplug_profiles WHERE user_id = $1', [userId]);
  assert.deepEqual(row.rows[0].tags, ['Music'], 'THE TAGS MUST SURVIVE AN UNRELATED EDIT');
  assert.equal(row.rows[0].display_name, 'Keeper Renamed');
});

// ---------------------------------------------------------------------------
// Search — the reason tags exist at all
// ---------------------------------------------------------------------------

test('SEARCH FINDS A LISTING BY A TAG THAT IS NOWHERE IN ITS NAME OR BIO', async () => {
  const userId = await makeUser();
  const id = await makeListing(userId, 'Bo-Kaap Bakery', 'We bake bread every morning.');
  await pool.query(`UPDATE profiles SET tags = $1 WHERE id = $2`, [['Halaal', 'Confectionery'], id]);

  const res = await req('GET', '/search?q=halaal');
  assert.equal(res.status, 200);
  assert.ok(res.body.results.profiles.some((p) => p.id === id),
    'the whole point of a tag is being found by a word the text never uses');
});

test('search matches part of a tag', async () => {
  const res = await req('GET', '/search?q=confect');
  assert.ok(res.body.results.profiles.some((p) => (p.tags || []).includes('Confectionery')));
});

test('search finds an ARTICLE by tag', async () => {
  const author = await makeUser();
  const a = await pool.query(
    `INSERT INTO articles (author_user_id, title, body, status, tags, published_at)
     VALUES ($1, 'A Quiet Morning', 'Body text about nothing in particular at all.', 'approved', $2, now())
     RETURNING id`,
    [author, ['Loadshedding']]
  );
  const res = await req('GET', '/search?q=loadshedding');
  assert.ok(res.body.results.articles.some((x) => x.id === a.rows[0].id));
});

test('A MEMBER PROFILE IS SEARCHABLE ONLY ONCE PUBLISHED', async () => {
  // A search result is a public page. An unpublished profile is private.
  const userId = await makeUser();
  const token = tokenFor(userId);
  await req('PUT', '/my-unplug/me', {
    token, body: { username: 'hidden' + userId, displayName: 'Hidden Person', tags: ['Birdwatching'] },
  });

  let res = await req('GET', '/search?q=birdwatching');
  assert.equal((res.body.results.members || []).length, 0, 'an unpublished profile must not appear');

  await pool.query('UPDATE my_unplug_profiles SET is_published = true WHERE user_id = $1', [userId]);
  res = await req('GET', '/search?q=birdwatching');
  assert.ok((res.body.results.members || []).some((m) => m.user_id === userId),
    'once published it is findable by its tag');
});

test('search results always carry a members list, even when empty', async () => {
  // The page adds these lengths together; an undefined list makes the total
  // NaN and the overlay says nothing was found when something was.
  const res = await req('GET', '/search?q=zzzznothingmatches');
  assert.ok(Array.isArray(res.body.results.members));
  assert.ok(Array.isArray(res.body.results.articles));
});

// ---------------------------------------------------------------------------
// The admin view and the backfill
// ---------------------------------------------------------------------------

test('the admin tag list groups spellings together and flags them', async () => {
  const u1 = await makeUser();
  const u2 = await makeUser();
  const a = await makeListing(u1, 'Spelling One');
  const b = await makeListing(u2, 'Spelling Two');
  await pool.query('UPDATE profiles SET tags = $1 WHERE id = $2', [['Coffee'], a]);
  await pool.query('UPDATE profiles SET tags = $1 WHERE id = $2', [['coffee'], b]);

  const res = await req('GET', '/admin/tags', { token: adminToken });
  assert.equal(res.status, 200);
  const coffee = res.body.tags.find((t) => t.key === 'coffee');
  assert.ok(coffee, 'both spellings collapse into one row');
  assert.ok(coffee.uses >= 2);
  assert.ok(coffee.spellings >= 2, 'and the report says it is written more than one way');
  assert.ok(res.body.totals.withMultipleSpellings >= 1);
});

test('renaming merges one spelling into another without duplicating', async () => {
  const res = await req('POST', '/admin/tags/rename', {
    token: adminToken, body: { from: 'coffee', to: 'Coffee' },
  });
  assert.equal(res.status, 200);

  const rows = await pool.query(
    `SELECT tags FROM profiles WHERE 'Coffee' = ANY(tags) OR 'coffee' = ANY(tags)`
  );
  rows.rows.forEach((r) => {
    const lower = r.tags.filter((t) => t.toLowerCase() === 'coffee');
    assert.equal(lower.length, 1, 'a row that had both must not end up with Coffee twice');
    assert.equal(lower[0], 'Coffee');
  });
});

test('THE BACKFILL NEVER OVERWRITES A TAG SOMEBODY CHOSE', async () => {
  const userId = await makeUser();
  const id = await makeListing(userId, 'Already Tagged',
    'A long biography about a family bakery that has been running in the same street for forty years.');
  await pool.query('UPDATE profiles SET tags = $1 WHERE id = $2', [['Chosen By Hand'], id]);

  const res = await req('POST', '/admin/tags/backfill', { token: adminToken, body: {} });
  assert.equal(res.status, 200);

  const row = await pool.query('SELECT tags FROM profiles WHERE id = $1', [id]);
  assert.deepEqual(row.rows[0].tags, ['Chosen By Hand'], 'a curated tag is never replaced');
});

test('the backfill fills the empty ones, and stops short of ten', async () => {
  const userId = await makeUser();
  const id = await makeListing(userId, 'Needs Tags',
    'We roast coffee beans in small batches and supply restaurants across the province with fresh coffee every week.');

  await req('POST', '/admin/tags/backfill', { token: adminToken, body: {} });

  const row = await pool.query('SELECT tags FROM profiles WHERE id = $1', [id]);
  assert.ok(row.rows[0].tags && row.rows[0].tags.length > 0, 'an untagged listing gets suggestions');
  assert.ok(row.rows[0].tags.length <= 10);
  // Padding to ten would mean filler words, and filler feeds the topic reports.
  row.rows[0].tags.forEach((t) => {
    assert.ok(!['Something', 'Someone', 'South'].includes(t), `junk tag suggested: ${t}`);
  });
});

test('a dry run changes nothing', async () => {
  const userId = await makeUser();
  const id = await makeListing(userId, 'Dry Run Listing',
    'A long description of a plumbing business operating across three towns for over a decade now.');
  const res = await req('POST', '/admin/tags/backfill', { token: adminToken, body: { dryRun: true } });
  assert.equal(res.body.dryRun, true);
  const row = await pool.query('SELECT tags FROM profiles WHERE id = $1', [id]);
  assert.ok(!row.rows[0].tags || row.rows[0].tags.length === 0, 'a dry run must not write');
});

test('the tag admin is admin-only', async () => {
  const memberToken = tokenFor(await makeUser());
  assert.equal((await req('GET', '/admin/tags')).status, 401);
  assert.equal((await req('GET', '/admin/tags', { token: memberToken })).status, 403);
  assert.equal((await req('POST', '/admin/tags/backfill', { token: memberToken, body: {} })).status, 403);
  assert.equal((await req('POST', '/admin/tags/rename', { token: memberToken, body: { from: 'a', to: 'b' } })).status, 403);
});

test('re-running every migration is idempotent', async () => {
  const before = await pool.query(`SELECT COUNT(*)::int AS n FROM profiles WHERE tags IS NOT NULL`);
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }
  const after = await pool.query(`SELECT COUNT(*)::int AS n FROM profiles WHERE tags IS NOT NULL`);
  assert.equal(after.rows[0].n, before.rows[0].n, 'a re-deploy must not disturb tags');
});
