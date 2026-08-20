// ADMIN — linking a Directory listing to a Passport account, and a sales
// consultant record to the account they sign in with.
//
// The guarantees worth testing hardest:
//   1. The two systems stay SEPARATE. Linking must not touch the member's
//      account, their My Unplug profile, or fold one record into the other.
//   2. profiles.user_id is UNIQUE. Linking to an account that already holds a
//      listing must fail with a readable message naming the listing in the
//      way — never a raw duplicate-key error mid-transaction.
//   3. A wrong link must be undoable. The previous owner is overwritten by
//      the link itself, so without history it is gone.
//   4. The transfer and its history row are one transaction: a listing that
//      moved with no record of where it came from is unrecoverable.
//   5. Admin-only.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-links-'));
const port = 24000 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

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

let jwt;
function tokenFor(userId, role = 'member') {
  return jwt.sign({ id: userId, email: `pl${userId}@test.com`, role }, process.env.JWT_SECRET);
}

let _nextUserId = 101000;
async function makeUser(role = 'member') {
  const id = _nextUserId++;
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role, full_name)
     VALUES ($1, $2, 'x', $3, $4) ON CONFLICT DO NOTHING`,
    [id, `pl${id}@test.com`, role, `Member ${id}`]
  );
  return id;
}

let _nextSlug = 0;
async function makeListing(userId, name) {
  const r = await pool.query(
    `INSERT INTO profiles (user_id, type, package_tier, slug, display_name, status)
     VALUES ($1, 'business', 'pro', $2, $3, 'approved') RETURNING id`,
    [userId, `pl-listing-${_nextSlug++}`, name]
  );
  return r.rows[0].id;
}

async function waitForLog(action, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const r = await pool.query('SELECT details FROM admin_activity_log WHERE action = $1 ORDER BY id DESC LIMIT 1', [action]);
    if (r.rowCount) return r.rows[0];
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
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
  process.env.JWT_SECRET = 'test-secret-for-profile-links';
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
  app.use('/admin/links', require('../src/routes/adminProfileLinks'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  adminToken = tokenFor(await makeUser('admin'), 'admin');
  memberToken = tokenFor(await makeUser('member'), 'member');
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  // Windows can still hold a handle on the data directory when Postgres
  // exits, and embedded-postgres removes that directory as part of
  // stopping. The server is already down by then, so an EBUSY here is
  // the OS being slow to let go, not a failure worth failing the file
  // for — and a teardown that goes red teaches everyone to ignore red.
  try { if (pg) await pg.stop(); } catch (e) { /* see above */ }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* Windows holds the dir briefly */ }
});

test('an admin can link an existing listing to a member account', async () => {
  const placeholderId = await makeUser();
  const memberId = await makeUser();
  const listingId = await makeListing(placeholderId, 'Kasi Coffee Co');

  const res = await req('POST', `/admin/links/directory/${listingId}`, {
    token: adminToken, body: { userId: memberId, reason: 'Owner signed up' },
  });
  assert.equal(res.status, 200);

  const row = await pool.query('SELECT user_id FROM profiles WHERE id = $1', [listingId]);
  assert.equal(row.rows[0].user_id, memberId);
});

test('linking does NOT touch the member account or create a second profile', async () => {
  // The whole point of the separation: a Directory listing is a paid service,
  // a Passport account is the member's own record. Linking relates them; it
  // must not merge, copy or duplicate either one.
  const placeholderId = await makeUser();
  const memberId = await makeUser();
  const listingId = await makeListing(placeholderId, 'Separation Test');

  const userBefore = await pool.query('SELECT email, full_name, role FROM users WHERE id = $1', [memberId]);
  await req('POST', `/admin/links/directory/${listingId}`, { token: adminToken, body: { userId: memberId } });
  const userAfter = await pool.query('SELECT email, full_name, role FROM users WHERE id = $1', [memberId]);

  assert.deepEqual(userAfter.rows[0], userBefore.rows[0], 'the member account must be untouched');

  const profiles = await pool.query('SELECT COUNT(*) AS n FROM profiles WHERE user_id = $1', [memberId]);
  assert.equal(Number(profiles.rows[0].n), 1, 'exactly one listing, not a duplicate');

  const mu = await pool.query('SELECT COUNT(*) AS n FROM my_unplug_profiles WHERE user_id = $1', [memberId]);
  assert.equal(Number(mu.rows[0].n), 0, 'linking a Directory listing must not create a My Unplug profile');
});

test('linking to an account that already holds a listing is refused by name', async () => {
  const ownerA = await makeUser();
  const ownerB = await makeUser();
  await makeListing(ownerB, 'Already Held Listing');
  const listingId = await makeListing(ownerA, 'Wants To Move');

  const res = await req('POST', `/admin/links/directory/${listingId}`, {
    token: adminToken, body: { userId: ownerB },
  });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /Already Held Listing/, 'the message should name the listing in the way');

  const row = await pool.query('SELECT user_id FROM profiles WHERE id = $1', [listingId]);
  assert.equal(row.rows[0].user_id, ownerA, 'the listing must not have moved');
});

test('linking a listing to the account it already belongs to is refused', async () => {
  const ownerId = await makeUser();
  const listingId = await makeListing(ownerId, 'Same Owner');
  const res = await req('POST', `/admin/links/directory/${listingId}`, {
    token: adminToken, body: { userId: ownerId },
  });
  assert.equal(res.status, 409);
});

test('a wrong link can be undone, putting the listing back', async () => {
  const rightOwner = await makeUser();
  const wrongOwner = await makeUser();
  const listingId = await makeListing(rightOwner, 'Mislinked Listing');

  await req('POST', `/admin/links/directory/${listingId}`, { token: adminToken, body: { userId: wrongOwner } });
  let row = await pool.query('SELECT user_id FROM profiles WHERE id = $1', [listingId]);
  assert.equal(row.rows[0].user_id, wrongOwner);

  const undo = await req('POST', `/admin/links/directory/${listingId}/revert`, { token: adminToken, body: {} });
  assert.equal(undo.status, 200);
  row = await pool.query('SELECT user_id FROM profiles WHERE id = $1', [listingId]);
  assert.equal(row.rows[0].user_id, rightOwner, 'the listing should be back with its original account');
});

test('every link is recorded with where it came from and who did it', async () => {
  const fromId = await makeUser();
  const toId = await makeUser();
  const listingId = await makeListing(fromId, 'History Listing');

  await req('POST', `/admin/links/directory/${listingId}`, {
    token: adminToken, body: { userId: toId, reason: 'Verified by phone' },
  });

  const res = await req('GET', `/admin/links/directory/${listingId}/history`, { token: adminToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.history.length, 1);
  assert.equal(res.body.history[0].from_user_id, fromId);
  assert.equal(res.body.history[0].to_user_id, toId);
  assert.equal(res.body.history[0].reason, 'Verified by phone');
  assert.ok(res.body.history[0].admin_email, 'the admin who did it should be recorded');

  const log = await waitForLog('directory_listing_linked');
  assert.ok(log);
});

test('a refused link writes no history at all', async () => {
  // The move and its history row are one transaction. A half-applied link is
  // the one outcome that cannot be recovered from.
  const ownerA = await makeUser();
  const ownerB = await makeUser();
  await makeListing(ownerB, 'Blocking Listing');
  const listingId = await makeListing(ownerA, 'Rollback Listing');

  await req('POST', `/admin/links/directory/${listingId}`, { token: adminToken, body: { userId: ownerB } });

  const history = await pool.query('SELECT COUNT(*) AS n FROM profile_link_history WHERE profile_id = $1', [listingId]);
  assert.equal(Number(history.rows[0].n), 0);
});

test('the member picker flags accounts that already hold a listing', async () => {
  const held = await makeUser();
  await makeListing(held, 'Picker Flag Listing');
  const res = await req('GET', '/admin/links/members', { token: adminToken });
  assert.equal(res.status, 200);
  const row = res.body.members.find((m) => m.id === held);
  assert.ok(row);
  assert.equal(row.existing_profile_name, 'Picker Flag Listing');
});

test('an admin can link and unlink a sales consultant', async () => {
  const userId = await makeUser();
  const c = await pool.query(
    `INSERT INTO sales_consultants (name, email) VALUES ('Linkable Consultant', 'lc@test.com') RETURNING id`
  );
  const consultantId = c.rows[0].id;

  const linked = await req('POST', `/admin/links/consultants/${consultantId}`, {
    token: adminToken, body: { userId },
  });
  assert.equal(linked.status, 200);
  let row = await pool.query('SELECT user_id FROM sales_consultants WHERE id = $1', [consultantId]);
  assert.equal(row.rows[0].user_id, userId);

  const unlinked = await req('POST', `/admin/links/consultants/${consultantId}`, {
    token: adminToken, body: { userId: null },
  });
  assert.equal(unlinked.status, 200);
  row = await pool.query('SELECT user_id FROM sales_consultants WHERE id = $1', [consultantId]);
  assert.equal(row.rows[0].user_id, null);
});

test('one account cannot be linked to two consultant records', async () => {
  // Nothing in the schema stops this, so a duplicate would silently attribute
  // one person's referrals to two records.
  const userId = await makeUser();
  const a = await pool.query(`INSERT INTO sales_consultants (name) VALUES ('Consultant One') RETURNING id`);
  const b = await pool.query(`INSERT INTO sales_consultants (name) VALUES ('Consultant Two') RETURNING id`);

  await req('POST', `/admin/links/consultants/${a.rows[0].id}`, { token: adminToken, body: { userId } });
  const second = await req('POST', `/admin/links/consultants/${b.rows[0].id}`, { token: adminToken, body: { userId } });
  assert.equal(second.status, 409);
  assert.match(second.body.error, /Consultant One/);
});

test('linking is admin-only', async () => {
  assert.equal((await req('GET', '/admin/links/directory')).status, 401);
  assert.equal((await req('GET', '/admin/links/directory', { token: memberToken })).status, 403);
  assert.equal((await req('POST', '/admin/links/directory/1', { token: memberToken, body: { userId: 1 } })).status, 403);
  assert.equal((await req('POST', '/admin/links/consultants/1', { token: memberToken, body: { userId: 1 } })).status, 403);
});

test('re-running every migration is idempotent', async () => {
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }
  const n = await pool.query('SELECT COUNT(*) AS n FROM profile_link_history');
  assert.ok(Number(n.rows[0].n) > 0, 'history must survive a migration re-run');
});
