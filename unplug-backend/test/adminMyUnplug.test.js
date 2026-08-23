// ADMIN — My Unplug management + analytics (routes/adminMyUnplug.js).
//
// The guarantees worth testing hardest:
//   1. Deleting a My Unplug profile must NOT delete the user account or the
//      member's Directory listing — three separate things, one destructive
//      action, and getting it wrong destroys something paid for.
//   2. Every analytics number must come from real rows, so seeding known data
//      must produce exactly predictable output.
//   3. Admin routes must be admin-only.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-adminmu-'));
const port = 22800 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

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
  return jwt.sign({ id: userId, email: `amu${userId}@test.com`, role }, process.env.JWT_SECRET);
}

let _nextUserId = 71000;
async function makeUser(role = 'member') {
  const id = _nextUserId++;
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', $3) ON CONFLICT DO NOTHING`,
    [id, `amu${id}@test.com`, role]
  );
  return id;
}

// The routes fire logActivity WITHOUT awaiting it, deliberately — audit
// logging must never delay or fail a response. So a test asserting the log
// row has to give that write a moment to land rather than checking instantly.
async function waitForLog(action, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const r = await pool.query('SELECT details FROM admin_activity_log WHERE action = $1 ORDER BY id DESC LIMIT 1', [action]);
    if (r.rowCount) return r.rows[0];
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

let _nextHandle = 0;
// Inserts a profile directly so a test can control exactly which fields are
// set — that is what makes the analytics assertions predictable.
async function makeProfile(userId, opts = {}) {
  const username = opts.username || `amu_${_nextHandle++}`;
  await pool.query(
    `INSERT INTO my_unplug_profiles
       (user_id, username, display_name, about_me, avatar_url, province, is_published, published_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $7 THEN now() ELSE NULL END)`,
    [
      userId, username, opts.displayName || 'Member',
      opts.aboutMe === undefined ? 'About text' : opts.aboutMe,
      opts.avatarUrl === undefined ? 'https://x.test/a.jpg' : opts.avatarUrl,
      // === undefined, not ||: a deliberately blank province is a real case
      // this file tests, and `'' || default` would quietly replace it.
      opts.province === undefined ? 'Gauteng' : opts.province,
      opts.published === true,
    ]
  );
  for (const key of opts.interests || []) {
    await pool.query('INSERT INTO mu_profile_interests (user_id, key) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, key]);
  }
  for (const key of opts.skills || []) {
    await pool.query('INSERT INTO mu_profile_skills (user_id, key) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, key]);
  }
  return username;
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
  process.env.JWT_SECRET = 'test-secret-for-adminmu';
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
  app.use('/admin/my-unplug', require('../src/routes/adminMyUnplug'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await pool.end();
  // Windows can still hold a handle on the data directory when Postgres
  // exits, and embedded-postgres removes that directory as part of
  // stopping. The server is already down by then, so an EBUSY here is
  // the OS being slow to let go, not a failure worth failing the file
  // for — and a teardown that goes red teaches everyone to ignore red.
  try { if (pg) await pg.stop(); } catch (e) { /* see above */ }
});

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

test('every admin My Unplug route is admin-only', async () => {
  const member = await makeUser();
  const paths = [
    ['GET', '/admin/my-unplug/profiles'],
    ['GET', '/admin/my-unplug/analytics'],
    ['GET', '/admin/my-unplug/profiles/1'],
    ['PATCH', '/admin/my-unplug/profiles/1'],
    ['DELETE', '/admin/my-unplug/profiles/1'],
  ];
  for (const [method, p] of paths) {
    // Only the mutating verbs get a body — fetch rejects a GET with one.
    const body = method === 'PATCH' ? { displayName: 'x' } : undefined;
    const anon = await req(method, p, { body });
    assert.ok([401, 403].includes(anon.status), `${method} ${p} allowed an anonymous request (${anon.status})`);
    const asMember = await req(method, p, { token: tokenFor(member), body });
    assert.equal(asMember.status, 403, `${method} ${p} allowed a normal member`);
  }
});

// ---------------------------------------------------------------------------
// Management
// ---------------------------------------------------------------------------

test('the profile list includes private profiles and is searchable', async () => {
  const admin = await makeUser('admin');
  const a = await makeUser();
  const b = await makeUser();
  const pub = await makeProfile(a, { displayName: 'Searchable Person', published: true });
  const priv = await makeProfile(b, { displayName: 'Hidden Person', published: false });

  const all = await req('GET', '/admin/my-unplug/profiles', { token: tokenFor(admin, 'admin') });
  assert.equal(all.status, 200);
  const names = all.body.profiles.map((p) => p.username);
  assert.ok(names.includes(pub), 'published profile missing');
  assert.ok(names.includes(priv), 'admin list must include private profiles too');

  const search = await req('GET', '/admin/my-unplug/profiles?q=Searchable', { token: tokenFor(admin, 'admin') });
  assert.equal(search.body.profiles.length, 1);
  assert.equal(search.body.profiles[0].username, pub);

  const onlyPrivate = await req('GET', '/admin/my-unplug/profiles?status=private', { token: tokenFor(admin, 'admin') });
  assert.ok(onlyPrivate.body.profiles.every((p) => p.is_published === false));
});

test('an admin can moderate the free-text fields', async () => {
  const admin = await makeUser('admin');
  const user = await makeUser();
  await makeProfile(user, { displayName: 'Bad Name' });

  const r = await req('PATCH', `/admin/my-unplug/profiles/${user}`, {
    token: tokenFor(admin, 'admin'),
    body: { displayName: 'Moderated Name', aboutMe: 'Cleaned up.' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.profile.display_name, 'Moderated Name');

  assert.ok(await waitForLog('myunplug_profile_edited'), 'a moderation edit must be audit-logged');
});

test('unpublishing requires a reason and takes the profile out of public view', async () => {
  const admin = await makeUser('admin');
  const user = await makeUser();
  await makeProfile(user, { published: true });

  const noReason = await req('POST', `/admin/my-unplug/profiles/${user}/unpublish`, { token: tokenFor(admin, 'admin'), body: {} });
  assert.equal(noReason.status, 400, 'a moderation action with no reason cannot be reviewed later');

  const done = await req('POST', `/admin/my-unplug/profiles/${user}/unpublish`, {
    token: tokenFor(admin, 'admin'), body: { reason: 'Impersonation report' },
  });
  assert.equal(done.status, 200);
  const row = await pool.query('SELECT is_published FROM my_unplug_profiles WHERE user_id = $1', [user]);
  assert.equal(row.rows[0].is_published, false);

  const logged = await waitForLog('myunplug_profile_unpublished');
  assert.ok(logged, 'the unpublish action must be audit-logged');
  assert.match(logged.details, /Impersonation report/, 'the stated reason must be in the audit log');
});

test('deleting a My Unplug profile leaves the account AND the Directory listing intact', async () => {
  // The costly mistake this guards: one destructive click wiping a paid
  // Directory listing or locking someone out of their account.
  const admin = await makeUser('admin');
  const user = await makeUser();
  await makeProfile(user);
  await pool.query(
    `INSERT INTO profiles (user_id, type, package_tier, slug, display_name, status)
     VALUES ($1, 'individual', 'basic', $2, 'Their Directory Listing', 'approved')`,
    [user, `amu-dir-${user}`]
  );

  const del = await req('DELETE', `/admin/my-unplug/profiles/${user}`, { token: tokenFor(admin, 'admin') });
  assert.equal(del.status, 200);

  assert.equal((await pool.query('SELECT 1 FROM my_unplug_profiles WHERE user_id = $1', [user])).rowCount, 0, 'profile should be gone');
  assert.equal((await pool.query('SELECT 1 FROM users WHERE id = $1', [user])).rowCount, 1, 'the user account must survive');
  assert.equal((await pool.query('SELECT 1 FROM profiles WHERE user_id = $1', [user])).rowCount, 1, 'the Directory listing must survive');
});

test('the single-profile view reports completion and whether they also have a Directory listing', async () => {
  const admin = await makeUser('admin');
  const user = await makeUser();
  await makeProfile(user, { interests: ['music'], skills: ['writing'] });

  const r = await req('GET', `/admin/my-unplug/profiles/${user}`, { token: tokenFor(admin, 'admin') });
  assert.equal(r.status, 200);
  assert.equal(r.body.profile.has_directory_listing, false);
  assert.ok(r.body.completion.percent > 0);
  assert.deepEqual(r.body.taxonomies.interests.map((i) => i.key), ['music']);
  // Purposes were never set, so completion must not be 100.
  assert.ok(r.body.completion.percent < 100);
});

// ---------------------------------------------------------------------------
// Analytics — every figure from real rows
// ---------------------------------------------------------------------------

test('analytics totals and the published rate match the seeded data exactly', async () => {
  const admin = await makeUser('admin');
  // Fresh table so the arithmetic is exact rather than "greater than".
  await pool.query('DELETE FROM my_unplug_profiles');
  const a = await makeUser(); const b = await makeUser(); const c = await makeUser();
  await makeProfile(a, { published: true });
  await makeProfile(b, { published: true });
  await makeProfile(c, { published: false });

  const { status, body } = await req('GET', '/admin/my-unplug/analytics', { token: tokenFor(admin, 'admin') });
  assert.equal(status, 200);
  assert.equal(body.totals.total, 3);
  assert.equal(body.totals.published, 2);
  assert.equal(body.totals.private, 1);
  assert.equal(body.totals.publishedRate, 66.7, '2 of 3 published');
});

test('the activation funnel narrows stage by stage', async () => {
  const admin = await makeUser('admin');
  await pool.query('DELETE FROM my_unplug_profiles');
  const a = await makeUser(); const b = await makeUser(); const c = await makeUser();
  await makeProfile(a, { published: true, interests: ['music'] }); // all the way
  await makeProfile(b, { published: false, interests: ['music'] }); // stopped before publishing
  await makeProfile(c, { published: false, avatarUrl: null, aboutMe: null }); // barely started

  const { body } = await req('GET', '/admin/my-unplug/analytics', { token: tokenFor(admin, 'admin') });
  const stage = (name) => body.activationFunnel.find((s) => s.stage === name).users;
  assert.equal(stage('Profile started'), 3);
  assert.equal(stage('Added photo + about'), 2, 'the third profile has neither');
  assert.equal(stage('Picked interests'), 2);
  assert.equal(stage('Published'), 1);
  // Conversions are percentages of registered users, so they never exceed 100.
  assert.ok(body.activationFunnel.every((s) => s.conversion >= 0 && s.conversion <= 100));
});

test('completion analytics name what members most commonly leave out', async () => {
  const admin = await makeUser('admin');
  await pool.query('DELETE FROM my_unplug_profiles');
  const a = await makeUser(); const b = await makeUser();
  // Neither has picked a purpose; neither has skills. Both have everything else.
  await makeProfile(a, { interests: ['music'] });
  await makeProfile(b, { interests: ['art'] });

  const { body } = await req('GET', '/admin/my-unplug/analytics', { token: tokenFor(admin, 'admin') });
  const missing = Object.fromEntries(body.completion.mostCommonlyMissing.map((m) => [m.label, m.count]));
  assert.equal(missing['Add your skills'], 2);
  assert.equal(missing['Set what you are plugging into'], 2);
  assert.equal(missing['Pick your interests'], undefined, 'both picked interests, so it must not be listed as missing');
  assert.ok(body.completion.average > 0 && body.completion.average < 100);
});

test('taxonomy popularity counts real selections', async () => {
  const admin = await makeUser('admin');
  await pool.query('DELETE FROM my_unplug_profiles');
  const a = await makeUser(); const b = await makeUser(); const c = await makeUser();
  await makeProfile(a, { interests: ['music', 'travel'] });
  await makeProfile(b, { interests: ['music'] });
  await makeProfile(c, { interests: ['music'] });

  const { body } = await req('GET', '/admin/my-unplug/analytics', { token: tokenFor(admin, 'admin') });
  const top = body.topInterests[0];
  assert.equal(top.label, 'Music');
  assert.equal(top.n, 3);
  const travel = body.topInterests.find((i) => i.label === 'Travel');
  assert.equal(travel.n, 1);
});

test('geography groups by province and labels the blanks honestly', async () => {
  const admin = await makeUser('admin');
  await pool.query('DELETE FROM my_unplug_profiles');
  const a = await makeUser(); const b = await makeUser(); const c = await makeUser();
  await makeProfile(a, { province: 'Gauteng' });
  await makeProfile(b, { province: 'Gauteng' });
  await makeProfile(c, { province: '' });

  const { body } = await req('GET', '/admin/my-unplug/analytics', { token: tokenFor(admin, 'admin') });
  const byProvince = Object.fromEntries(body.byProvince.map((r) => [r.province, r.n]));
  assert.equal(byProvince['Gauteng'], 2);
  assert.equal(byProvince['Not given'], 1, 'a blank province should be labelled, not silently dropped');
});

test('analytics work on an empty table rather than dividing by zero', async () => {
  const admin = await makeUser('admin');
  await pool.query('DELETE FROM my_unplug_profiles');
  const { status, body } = await req('GET', '/admin/my-unplug/analytics', { token: tokenFor(admin, 'admin') });
  assert.equal(status, 200);
  assert.equal(body.totals.total, 0);
  assert.equal(body.totals.publishedRate, 0);
  assert.equal(body.completion.average, 0);
  assert.deepEqual(body.topInterests, []);
});

test('the daily series covers the whole requested window, including days with nothing', async () => {
  const admin = await makeUser('admin');
  const { body } = await req('GET', '/admin/my-unplug/analytics?days=7', { token: tokenFor(admin, 'admin') });
  assert.equal(body.windowDays, 7);
  // generate_series is inclusive of both ends, so 7 days spans 8 points.
  assert.ok(body.series.length >= 7 && body.series.length <= 9, `unexpected series length ${body.series.length}`);
  assert.ok(body.series.every((d) => typeof d.profiles_created === 'number'));
});
