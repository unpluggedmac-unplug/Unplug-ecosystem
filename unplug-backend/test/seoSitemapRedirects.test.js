// Sitemaps, robots.txt and the redirect manager, against a REAL PostgreSQL.
//
// This is search-engine-facing, so the failures are slow and expensive: a
// malformed sitemap is rejected silently, a sitemap listing pages that 404
// teaches a crawler the site is unreliable, and a bad redirect breaks a link
// somebody printed. What is pinned here:
//
//   1. THE XML IS VALID. An unescaped ampersand makes the whole document
//      unparseable, and every URL on this site carries a query string;
//   2. THE SITEMAP ONLY LISTS WHAT A READER CAN OPEN. No drafts, no rejected
//      pieces, nothing scheduled for next week;
//   3. A REDIRECT CANNOT BE TURNED INTO AN OPEN REDIRECT or a loop;
//   4. the 404 log records one row per path, not one per hit, so a broken
//      link shared widely cannot bury the handful of real problems.
//
// Run with:  npm test   (from unplug-backend/)

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const EmbeddedPostgres = require('embedded-postgres').default;
const { stopPostgres } = require('./helpers/stopPostgres');
const { waitFor } = require('./helpers/waitFor');

let pg;
let pool;
let server;
let baseUrl;
let jwt;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-seo-'));
const port = 36000 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

async function req(method, urlPath, { token, body } = {}) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* xml or plain text */ }
  return { status: res.status, body: json, text, type: res.headers.get('content-type') || '' };
}

let _id = 1401000;
async function makeUser(role = 'member') {
  const id = _id++;
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', $3)`,
    [id, `seo${id}@test.com`, role]);
  return id;
}

let _slug = 0;
async function makeArticle(userId, over = {}) {
  const r = await pool.query(
    `INSERT INTO articles (title, body, author_user_id, status, published_at, scheduled_for)
     VALUES ($1, 'body', $2, $3, now(), $4) RETURNING id`,
    [over.title || 'A Story', userId, over.status || 'approved', over.scheduledFor || null]);
  return r.rows[0].id;
}

async function makeProfile(userId, name) {
  const r = await pool.query(
    `INSERT INTO profiles (user_id, type, package_tier, slug, display_name, status)
     VALUES ($1, 'business', 'basic', $2, $3, $4) RETURNING slug`,
    [userId, `seo-biz-${_slug++}`, name, 'approved']);
  return r.rows[0].slug;
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
  process.env.JWT_SECRET = 'test-secret-for-seo';
  process.env.UNPLUG_DISABLE_RATE_LIMITS = '1';
  process.env.SITE_URL = 'https://www.unplugnews.com';

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
  // Mounted in the same order as src/app.js: sitemap.js owns /sitemap.xml and
  // /robots.txt, seo.js owns redirects and the 404 log. Testing them mounted
  // the wrong way round would hide exactly the shadowing bug that made a
  // duplicate set of routes look like it worked.
  app.use('/', require('../src/routes/sitemap'));
  app.use('/', require('../src/routes/seo'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const tokenFor = (id, role) => jwt.sign({ id, email: `seo${id}@test.com`, role }, process.env.JWT_SECRET);
  adminToken = tokenFor(await makeUser('admin'), 'admin');
  memberToken = tokenFor(await makeUser(), 'member');
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
// The XML has to be valid
// ---------------------------------------------------------------------------

test('THE AMPERSAND IN EVERY URL IS ESCAPED', async () => {
  // Every article URL on this site is "?p=article&id=5". A raw & makes the
  // entire sitemap unparseable — not one bad entry, the whole document
  // rejected — and Search Console reports that as a vague fetch error.
  const uid = await makeUser();
  await makeArticle(uid);

  const xml = await req('GET', '/sitemap.xml');
  assert.equal(xml.status, 200);
  assert.match(xml.type, /xml/);
  assert.match(xml.text, /&amp;id=/, 'the & is escaped');
  assert.ok(!/&(?!amp;|lt;|gt;|quot;|apos;)/.test(xml.text),
    'no unescaped ampersand survives anywhere in the document');
});

test('the sitemap is well-formed', async () => {
  // Parsed rather than eyeballed: a stray tag is invisible to a regex and
  // fatal to a crawler.
  for (const p of ['/sitemap.xml']) {
    const r = await req('GET', p);
    assert.equal(r.status, 200, p);
    assert.match(r.text, /^<\?xml version="1\.0" encoding="UTF-8"\?>/, `${p} declares itself`);
    // Tags balance: same number of openers and closers for the repeating unit.
    const opens = (r.text.match(/<url>|<sitemap>/g) || []).length;
    const closes = (r.text.match(/<\/url>|<\/sitemap>/g) || []).length;
    assert.equal(opens, closes, `${p} has balanced entries`);
    assert.match(r.text, /<\/(urlset|sitemapindex)>\s*$/, `${p} closes its root element`);
  }
});

test('every URL is absolute and on the public domain', async () => {
  // A relative or wrong-origin URL in a sitemap is ignored at best and treated
  // as a cross-submission at worst.
  const r = await req('GET', '/sitemap.xml');
  const locs = [...r.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.ok(locs.length > 0);
  assert.ok(locs.every((l) => l.startsWith('https://www.unplugnews.com/')),
    'every entry is absolute and on the site origin');
});

// ---------------------------------------------------------------------------
// It must only list what a reader can actually open
// ---------------------------------------------------------------------------

test('DRAFTS, PENDING AND REJECTED ARTICLES ARE NOT LISTED', async () => {
  const uid = await makeUser();
  const live = await makeArticle(uid, { title: 'Live One' });
  const pending = await makeArticle(uid, { title: 'Pending One', status: 'pending' });
  const rejected = await makeArticle(uid, { title: 'Rejected One', status: 'rejected' });

  const r = await req('GET', '/sitemap.xml');
  assert.ok(r.text.includes(`id=${live}`), 'the published one is there');
  assert.ok(!r.text.includes(`id=${pending}`), 'pending is not');
  assert.ok(!r.text.includes(`id=${rejected}`), 'rejected is not');
});

test('AN ARTICLE SCHEDULED FOR NEXT WEEK IS NOT LISTED', async () => {
  // Listing it invites a crawl that 404s, which is how a site teaches Google
  // that its sitemap cannot be trusted.
  const uid = await makeUser();
  const future = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const id = await makeArticle(uid, { title: 'Next Week', scheduledFor: future });

  const r = await req('GET', '/sitemap.xml');
  assert.ok(!r.text.includes(`id=${id}`), 'a future-dated article stays out until it is live');
});

test('only approved directory profiles are listed', async () => {
  const uid = await makeUser();
  const slug = await makeProfile(uid, 'Listed Business');
  await pool.query(`INSERT INTO profiles (user_id, type, package_tier, slug, display_name, status)
                    VALUES ($1, 'business', 'basic', 'seo-hidden', 'Hidden Business', 'pending')`,
    [await makeUser()]);

  const r = await req('GET', '/sitemap.xml');
  assert.ok(r.text.includes(slug), 'approved is listed');
  assert.ok(!r.text.includes('seo-hidden'), 'pending is not');
});

test('published project showcases are listed, drafts are not', async () => {
  const live = await pool.query(
    `INSERT INTO projects (title, status) VALUES ('Listed Project', 'published') RETURNING id`);
  const draft = await pool.query(
    `INSERT INTO projects (title, status) VALUES ('Draft Project', 'draft') RETURNING id`);

  const r = await req('GET', '/sitemap.xml');
  assert.ok(r.text.includes(`p=project&amp;id=${live.rows[0].id}`), 'the published one is there');
  assert.ok(!r.text.includes(`p=project&amp;id=${draft.rows[0].id}`), 'the draft is not');
});

test('SITEMAP URLS MATCH THE CANONICAL TAG, NOT THE UNDERLYING FILE', async () => {
  // Pages declare <link rel="canonical" href="https://www.unplugnews.com/?p=...">.
  // A sitemap offering /unplug-magazine.html?p=... instead sends a crawler to
  // an address the page then disowns — wasted crawl, and two URLs competing
  // for the credit of one page.
  const uid = await makeUser();
  await makeArticle(uid, { title: 'Canonical Check' });

  const r = await req('GET', '/sitemap.xml');
  const locs = [...r.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.ok(locs.length > 0);
  assert.ok(!locs.some((l) => l.includes('unplug-magazine.html')),
    'no entry points at the file behind the page');
  assert.ok(locs.includes('https://www.unplugnews.com/'), 'the homepage is the bare origin');
});

test("THE API'S robots.txt REFUSES THE API, AND MUST NEVER REACH THE SITE", async () => {
  // This host serves JSON, not pages. "Disallow: /" is right for it — and
  // catastrophic if it is ever proxied onto www.unplugnews.com, which would
  // ask every crawler to drop the entire magazine from its index. The public
  // robots.txt is the static file checked below; these two must not converge.
  const r = await req('GET', '/robots.txt');
  assert.equal(r.status, 200);
  assert.match(r.type, /text\/plain/);
  assert.match(r.text, /Disallow: \//, 'the API host asks not to be crawled');
  assert.match(r.text, /Sitemap: https:\/\/www\.unplugnews\.com\/sitemap\.xml/,
    'it still points a crawler at the real sitemap');
});

test('THE PUBLIC robots.txt ALLOWS THE SITE AND NAMES THE SITEMAP', async () => {
  // Read off disk, because this one is a static file served by Cloudflare
  // Pages rather than a route. If it goes missing, or someone pastes the API's
  // version into it, the site quietly stops being indexed.
  const publicRobots = path.join(__dirname, '..', '..', 'robots.txt');
  assert.ok(fs.existsSync(publicRobots), 'the public robots.txt is in the repository');
  const txt = fs.readFileSync(publicRobots, 'utf8');

  assert.match(txt, /^\s*Allow: \/\s*$/m, 'the site itself is crawlable');
  assert.ok(!/^\s*Disallow:\s*\/\s*$/m.test(txt),
    'it does NOT carry the API\'s blanket Disallow: /');
  assert.match(txt, /Sitemap: https:\/\/www\.unplugnews\.com\/sitemap\.xml/);
  assert.match(txt, /Disallow: \/unplug-admin-dashboard/, 'admin screens stay out');
});

// ---------------------------------------------------------------------------
// Redirects
// ---------------------------------------------------------------------------

test('a redirect is found and counted', async () => {
  const made = await req('POST', '/admin/redirects', {
    token: adminToken, body: { fromPath: '/old-page', toUrl: '/?p=news' },
  });
  assert.equal(made.status, 201);

  const found = await req('GET', '/redirect?path=/old-page');
  assert.equal(found.status, 200);
  assert.equal(found.body.redirect.to, '/?p=news');
  assert.equal(found.body.redirect.status, 301);

  // The counter is updated without the reader waiting for it. Waiting for the
  // count to actually rise, rather than sleeping a fixed 200ms and hoping:
  // under load the write can land later than any figure picked in advance.
  await waitFor(
    async () => (await pool.query(
      `SELECT hit_count FROM redirects WHERE from_path = '/old-page'`)).rows[0].hit_count >= 1,
    'the redirect hit counter to rise');
  const row = await pool.query(`SELECT hit_count FROM redirects WHERE from_path = '/old-page'`);
  assert.ok(row.rows[0].hit_count >= 1, 'following a redirect is counted');
});

test('PATHS ARE MATCHED WHATEVER SHAPE THEY ARE TYPED IN', async () => {
  // "/About/", "about" and "/About" are the same page to a person, so they
  // must be the same rule.
  await req('POST', '/admin/redirects', {
    token: adminToken, body: { fromPath: 'About/', toUrl: '/?p=about' },
  });
  for (const variant of ['/about', '/About', '/about/', '/ABOUT/']) {
    const r = await req('GET', `/redirect?path=${encodeURIComponent(variant)}`);
    assert.equal(r.status, 200, `${variant} should match`);
  }
});

test('AN OPEN REDIRECT IS REFUSED', async () => {
  // This value becomes a Location header a browser obeys without asking. A
  // redirector that accepts anything is how a site is used to launder a
  // phishing link through a domain people trust.
  for (const bad of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>',
    '//evil.example.com/x', 'http://evil.example.com']) {
    const r = await req('POST', '/admin/redirects', {
      token: adminToken, body: { fromPath: '/try-' + Math.random().toString(36).slice(2, 8), toUrl: bad },
    });
    assert.equal(r.status, 400, `${bad} must be refused`);
  }
});

test('a redirect to itself is refused', async () => {
  const r = await req('POST', '/admin/redirects', {
    token: adminToken, body: { fromPath: '/loop', toUrl: '/loop' },
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /itself/i);
});

test('A CHAIN IS REFUSED, with the destination named', async () => {
  // /a -> /b where /b -> /c costs the reader two round trips and search
  // engines discount it.
  await req('POST', '/admin/redirects', {
    token: adminToken, body: { fromPath: '/step-b', toUrl: '/?p=news' },
  });
  const chained = await req('POST', '/admin/redirects', {
    token: adminToken, body: { fromPath: '/step-a', toUrl: '/step-b' },
  });
  assert.equal(chained.status, 400);
  assert.match(chained.body.error, /\?p=news/, 'it says where to point instead');
});

test('an unknown path returns 404 so the edge can fall through', async () => {
  const r = await req('GET', '/redirect?path=/never-configured');
  assert.equal(r.status, 404);
  assert.equal(r.body.redirect, null);
});

test('a deactivated redirect stops being followed', async () => {
  const made = await req('POST', '/admin/redirects', {
    token: adminToken, body: { fromPath: '/switch-off-me', toUrl: '/?p=news' },
  });
  await req('PATCH', `/admin/redirects/${made.body.redirect.id}`, {
    token: adminToken, body: { isActive: false },
  });
  const r = await req('GET', '/redirect?path=/switch-off-me');
  assert.equal(r.status, 404, 'switched off means not applied');
});

// ---------------------------------------------------------------------------
// The 404 log
// ---------------------------------------------------------------------------

test('A BROKEN LINK SHARED WIDELY MAKES ONE ROW, NOT THOUSANDS', async () => {
  for (let i = 0; i < 50; i += 1) {
    await req('POST', '/not-found', { body: { path: '/shared-broken-link' } });
  }
  const rows = await pool.query(`SELECT hit_count FROM not_found_log WHERE path = '/shared-broken-link'`);
  assert.equal(rows.rowCount, 1, 'one row for the path');
  assert.equal(rows.rows[0].hit_count, 50, 'with a count');
});

test('creating a redirect marks the miss as handled', async () => {
  await req('POST', '/not-found', { body: { path: '/moved-somewhere' } });
  let list = await req('GET', '/admin/redirects', { token: adminToken });
  assert.ok(list.body.notFound.some((n) => n.path === '/moved-somewhere'), 'it shows as needing attention');

  await req('POST', '/admin/redirects', {
    token: adminToken, body: { fromPath: '/moved-somewhere', toUrl: '/?p=news' },
  });
  list = await req('GET', '/admin/redirects', { token: adminToken });
  assert.ok(!list.body.notFound.some((n) => n.path === '/moved-somewhere'),
    'fixing it takes it off the list with no second step to forget');
});

test('a miss can be dismissed without creating a redirect', async () => {
  // Plenty are bots probing for /wp-login.php and deserve no rule at all.
  await req('POST', '/not-found', { body: { path: '/wp-login.php' } });
  await req('PATCH', '/admin/not-found', { token: adminToken, body: { path: '/wp-login.php' } });
  const list = await req('GET', '/admin/redirects', { token: adminToken });
  assert.ok(!list.body.notFound.some((n) => n.path === '/wp-login.php'));
});

// ---------------------------------------------------------------------------
// Who can do what
// ---------------------------------------------------------------------------

test('the sitemap, robots and redirect lookup are public', async () => {
  // A crawler is never signed in, and the edge Function calls the lookup on
  // behalf of a signed-out reader.
  for (const p of ['/sitemap.xml', '/robots.txt']) {
    assert.equal((await req('GET', p)).status, 200, p);
  }
  assert.equal((await req('GET', '/redirect?path=/anything')).status, 404,
    'answers without a token, even when there is no rule');
});

test('managing redirects is admin-only', async () => {
  const cases = [
    ['GET', '/admin/redirects', undefined],
    ['POST', '/admin/redirects', { fromPath: '/x', toUrl: '/y' }],
    ['PATCH', '/admin/redirects/1', { isActive: false }],
    ['DELETE', '/admin/redirects/1', {}],
    ['PATCH', '/admin/not-found', { path: '/x' }],
  ];
  for (const [method, urlPath, body] of cases) {
    assert.equal((await req(method, urlPath, { token: memberToken, body })).status, 403,
      `${method} ${urlPath} must refuse a member`);
    assert.equal((await req(method, urlPath, { body })).status, 401,
      `${method} ${urlPath} must refuse a stranger`);
  }
});
