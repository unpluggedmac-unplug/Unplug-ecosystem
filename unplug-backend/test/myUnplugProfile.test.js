// MY UNPLUG — public profile (105_my_unplug_profiles.sql).
//
// The two guarantees worth testing hardest, because both fail silently:
//   1. PRIVACY — a stranger must never receive email/phone/password/role,
//      and an unpublished profile must not be reachable at all.
//   2. SEPARATION — creating a My Unplug profile must not create a Directory
//      listing, and creating a Directory listing must not touch My Unplug.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-myunplug-'));
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
  return jwt.sign({ id: userId, email: `mu${userId}@test.com`, role }, process.env.JWT_SECRET);
}

let _nextUserId = 61000;
async function makeUser(role = 'member') {
  const id = _nextUserId++;
  await pool.query(
    `INSERT INTO users (id, email, phone, password_hash, role)
     VALUES ($1, $2, '0820000000', 'super-secret-hash', $3) ON CONFLICT DO NOTHING`,
    [id, `mu${id}@test.com`, role]
  );
  return id;
}

let _nextHandle = 0;
function handle() { return `tester_${_nextHandle++}`; }

// Creates a saved (but NOT published) profile.
async function makeProfile(userId, overrides = {}) {
  const username = overrides.username || handle();
  const r = await req('PUT', '/my-unplug/me', {
    token: tokenFor(userId),
    body: { username, displayName: 'Test Member', aboutMe: 'Building things.', ...overrides },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { username, body: r.body };
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
  process.env.JWT_SECRET = 'test-secret-for-myunplug';
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
  app.use('/my-unplug', require('../src/routes/myUnplug'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await pool.end();
  await pg.stop();
});

// ---------------------------------------------------------------------------
// PRIVACY — the guarantees that fail silently
// ---------------------------------------------------------------------------

test('a published public profile exposes NO private field', async () => {
  const user = await makeUser();
  const { username } = await makeProfile(user);
  await req('POST', '/my-unplug/me/publish', { token: tokenFor(user) });

  const { status, body } = await req('GET', `/my-unplug/u/${username}`);
  assert.equal(status, 200);

  // Asserted against the serialised payload, not key-by-key: a nested object
  // or a future joined column would slip past a shallow key check.
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes('@test.com'), 'an email address reached the public profile');
  assert.ok(!raw.includes('0820000000'), 'a phone number reached the public profile');
  assert.ok(!raw.includes('super-secret-hash'), 'a password hash reached the public profile');
  for (const forbidden of ['email', 'phone', 'password', 'password_hash', 'role', 'date_of_birth', 'ip_address']) {
    assert.ok(!Object.keys(body.profile).includes(forbidden), `public profile exposed "${forbidden}"`);
  }
});

test('an UNPUBLISHED profile is not reachable publicly, and 404s rather than admitting it exists', async () => {
  const user = await makeUser();
  const { username } = await makeProfile(user);

  const anon = await req('GET', `/my-unplug/u/${username}`);
  assert.equal(anon.status, 404, 'an unpublished profile was publicly readable');
  // 404, not 403 — a 403 would confirm the handle is taken and by whom.
  assert.match(anon.body.error, /No published profile/);

  // The owner still sees their own.
  const mine = await req('GET', '/my-unplug/me', { token: tokenFor(user) });
  assert.equal(mine.body.profile.username, username);
  assert.equal(mine.body.profile.is_published, false);
});

test('publishing is opt-in — saving a profile never publishes it', async () => {
  const user = await makeUser();
  await makeProfile(user);
  const row = await pool.query('SELECT is_published, published_at FROM my_unplug_profiles WHERE user_id = $1', [user]);
  assert.equal(row.rows[0].is_published, false, 'saving a profile must not publish it');
  assert.equal(row.rows[0].published_at, null);
});

test('publish then unpublish takes it back out of public view', async () => {
  const user = await makeUser();
  const { username } = await makeProfile(user);

  await req('POST', '/my-unplug/me/publish', { token: tokenFor(user) });
  assert.equal((await req('GET', `/my-unplug/u/${username}`)).status, 200);

  await req('POST', '/my-unplug/me/unpublish', { token: tokenFor(user) });
  assert.equal((await req('GET', `/my-unplug/u/${username}`)).status, 404);

  // published_at survives, so a re-publish isn't mistaken for a new profile.
  const row = await pool.query('SELECT published_at FROM my_unplug_profiles WHERE user_id = $1', [user]);
  assert.ok(row.rows[0].published_at, 'published_at should be kept as the first-live date');
});

// ---------------------------------------------------------------------------
// SEPARATION from the Directory
// ---------------------------------------------------------------------------

test('creating a My Unplug profile does NOT create a Directory listing', async () => {
  const user = await makeUser();
  await makeProfile(user);
  const dir = await pool.query('SELECT 1 FROM profiles WHERE user_id = $1', [user]);
  assert.equal(dir.rowCount, 0, 'a Directory listing was created as a side effect');
});

test('creating a Directory listing does NOT touch My Unplug', async () => {
  const user = await makeUser();
  const { username } = await makeProfile(user);

  await pool.query(
    `INSERT INTO profiles (user_id, type, package_tier, slug, display_name, status, contact_email, contact_phone)
     VALUES ($1, 'individual', 'basic', $2, 'Directory Name', 'approved', 'dir@test.com', '0999999999')`,
    [user, `dir-${user}`]
  );

  const mine = await req('GET', '/my-unplug/me', { token: tokenFor(user) });
  assert.equal(mine.body.profile.username, username);
  assert.equal(mine.body.profile.display_name, 'Test Member', 'Directory data overwrote the My Unplug identity');

  // And the Directory's contact details must not surface on the public page.
  await req('POST', '/my-unplug/me/publish', { token: tokenFor(user) });
  const pub = await req('GET', `/my-unplug/u/${username}`);
  const raw = JSON.stringify(pub.body);
  assert.ok(!raw.includes('dir@test.com'), 'Directory contact email leaked into My Unplug');
  assert.ok(!raw.includes('0999999999'), 'Directory phone leaked into My Unplug');
});

// ---------------------------------------------------------------------------
// Usernames
// ---------------------------------------------------------------------------

test('usernames are unique case-insensitively', async () => {
  const a = await makeUser();
  const b = await makeUser();
  await makeProfile(a, { username: 'SarahM' });

  const clash = await req('PUT', '/my-unplug/me', {
    token: tokenFor(b), body: { username: 'sarahm', displayName: 'Someone Else' },
  });
  assert.equal(clash.status, 409, '@sarahm should collide with @SarahM');
});

test('reserved and malformed usernames are refused', async () => {
  const user = await makeUser();
  for (const username of ['admin', 'API', 'unplug', 'ab', 'has space', 'has-dash', 'x'.repeat(31)]) {
    const r = await req('PUT', '/my-unplug/me', { token: tokenFor(user), body: { username, displayName: 'X' } });
    assert.equal(r.status, 400, `"${username}" should have been refused`);
  }
});

test('the availability check agrees with what saving actually does', async () => {
  const a = await makeUser();
  await makeProfile(a, { username: 'taken_handle' });

  const taken = await req('GET', '/my-unplug/username-available?username=TAKEN_HANDLE');
  assert.equal(taken.body.available, false);
  const free = await req('GET', '/my-unplug/username-available?username=free_handle');
  assert.equal(free.body.available, true);
  const reserved = await req('GET', '/my-unplug/username-available?username=admin');
  assert.equal(reserved.body.available, false);
});

// ---------------------------------------------------------------------------
// Taxonomies + completion
// ---------------------------------------------------------------------------

test('interests, skills and purposes are multi-select and round-trip', async () => {
  const user = await makeUser();
  await makeProfile(user);

  const saved = await req('PUT', '/my-unplug/me/taxonomy', {
    token: tokenFor(user),
    body: {
      interests: ['photography', 'business', 'travel'],
      skills: ['photography', 'marketing'],
      purposes: ['creativity', 'entrepreneurship'],
    },
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.taxonomies.interests.map((i) => i.key).sort(), ['business', 'photography', 'travel']);
  assert.equal(saved.body.taxonomies.skills.length, 2);
  assert.equal(saved.body.taxonomies.purposes.length, 2);

  // Replacing a set removes what was dropped.
  const replaced = await req('PUT', '/my-unplug/me/taxonomy', { token: tokenFor(user), body: { interests: ['music'] } });
  assert.deepEqual(replaced.body.taxonomies.interests.map((i) => i.key), ['music']);
  // Sets not mentioned are left alone, so the three selects can save separately.
  assert.equal(replaced.body.taxonomies.skills.length, 2, 'skills should be untouched when only interests were sent');
});

test('unknown taxonomy keys are ignored rather than stored', async () => {
  const user = await makeUser();
  await makeProfile(user);
  const r = await req('PUT', '/my-unplug/me/taxonomy', {
    token: tokenFor(user), body: { interests: ['music', 'not_a_real_interest'] },
  });
  assert.deepEqual(r.body.taxonomies.interests.map((i) => i.key), ['music']);
});

test('profile completion rises as real fields are filled in', async () => {
  const user = await makeUser();
  const created = await makeProfile(user, { aboutMe: '' });
  const start = created.body.completion.percent;

  await req('PUT', '/my-unplug/me', {
    token: tokenFor(user),
    body: { username: created.username, displayName: 'Test Member', aboutMe: 'A short bio.', avatarUrl: 'https://x.test/a.jpg' },
  });
  const withTax = await req('PUT', '/my-unplug/me/taxonomy', {
    token: tokenFor(user), body: { interests: ['music'], skills: ['writing'], purposes: ['creativity'] },
  });

  assert.ok(withTax.body.completion.percent > start, 'completion did not increase');
  assert.equal(withTax.body.completion.percent, 100, 'every step done should be 100%');
  assert.ok(withTax.body.completion.steps.every((s) => s.done));
});

test('About Me is capped at 50 words', async () => {
  const user = await makeUser();
  const r = await req('PUT', '/my-unplug/me', {
    token: tokenFor(user),
    body: { username: handle(), displayName: 'Wordy', aboutMe: Array.from({ length: 51 }, (_, i) => `w${i}`).join(' ') },
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /50 words/);
});

// ---------------------------------------------------------------------------
// Auth + listing
// ---------------------------------------------------------------------------

test('editing a profile requires being signed in', async () => {
  const r = await req('PUT', '/my-unplug/me', { body: { username: handle(), displayName: 'Anon' } });
  assert.equal(r.status, 401);
});

test('publishing requires a username and display name', async () => {
  const user = await makeUser();
  // No profile at all yet.
  const none = await req('POST', '/my-unplug/me/publish', { token: tokenFor(user) });
  assert.equal(none.status, 400);
});

test('the published list contains only published profiles', async () => {
  const shown = await makeUser();
  const hidden = await makeUser();
  const a = await makeProfile(shown);
  const b = await makeProfile(hidden);
  await req('POST', '/my-unplug/me/publish', { token: tokenFor(shown) });

  const { body } = await req('GET', '/my-unplug/published?limit=60');
  const names = body.profiles.map((p) => p.username);
  assert.ok(names.includes(a.username));
  assert.ok(!names.includes(b.username), 'an unpublished profile appeared in the public list');
});

test('re-running every migration is idempotent — profiles and selections survive', async () => {
  const user = await makeUser();
  const { username } = await makeProfile(user);
  await req('PUT', '/my-unplug/me/taxonomy', { token: tokenFor(user), body: { interests: ['music'] } });

  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }

  const mine = await req('GET', '/my-unplug/me', { token: tokenFor(user) });
  assert.equal(mine.body.profile.username, username);
  assert.deepEqual(mine.body.taxonomies.interests.map((i) => i.key), ['music']);
  // Seeds must not have duplicated.
  const seeds = await pool.query(`SELECT COUNT(*)::int AS n FROM mu_interests WHERE key = 'music'`);
  assert.equal(seeds.rows[0].n, 1);
});
