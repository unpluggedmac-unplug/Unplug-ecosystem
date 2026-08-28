// Where a paid Gallery submission actually ends up.
//
// THE BUG. The member dashboard sells this as "Up to 3 photos submitted to the
// Community Gallery" for R100, then sent ownerType:'profile' whenever the
// member happened to have a Directory listing. The Community Gallery query
// excludes owner_type='profile', so the member paid, an admin approved
// something the queue labelled "Gallery image", and it appeared nowhere —
// or, if their listing was itself still pending, nowhere at all. Members
// WITHOUT a listing were unaffected, which is why it looked intermittent.
//
// What these tests protect:
//
//   1. A GALLERY SUBMISSION REACHES THE GALLERY. Once approved it is actually
//      returned by the public endpoint.
//   2. NOBODY WITH A FREE CREDIT GETS CHARGED. The free-credit check used to
//      sit behind the same owner_type condition; fixing the destination
//      without fixing that would have started charging R100 to members who
//      were holding a credit.
//   3. THE LISTING-PHOTO ALLOWANCE STILL MEANS LISTING PHOTOS. A business
//      tier's "N listing photo(s)" allowance must not silently become free
//      Community Gallery submissions.
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
let plainToken;      // a member with NO listing
let listingToken;    // a member WITH a listing — the case that broke
let creditToken;     // a member holding a free gallery credit
let adminToken;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-galdest-'));
const port = 45200 + (process.pid % 300); // bases are 400 apart so ranges cannot overlap

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

const img = (n) => ({ imageUrl: `https://example.test/${n}.jpg`, caption: 'Photo ' + n });

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
  process.env.JWT_SECRET = 'test-secret-for-galdest';
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
  app.use('/gallery', require('../src/routes/gallery'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await pool.query(`INSERT INTO users (id, email, full_name, password_hash, role) VALUES
    (610001, 'plain@test.com', 'Plain Member', 'x', 'member'),
    (610002, 'listing@test.com', 'Listing Member', 'x', 'member'),
    (610003, 'credit@test.com', 'Credit Member', 'x', 'member'),
    (610004, 'galadmin@test.com', 'Gallery Admin', 'x', 'admin')`);
  const sign = (id, email, role) => jwt.sign({ id, email, role: role || 'member' }, process.env.JWT_SECRET);
  plainToken = sign(610001, 'plain@test.com');
  listingToken = sign(610002, 'listing@test.com');
  creditToken = sign(610003, 'credit@test.com');
  adminToken = sign(610004, 'galadmin@test.com', 'admin');

  await pool.query(`INSERT INTO categories (id, name, type) VALUES (9501, 'Community', 'news')
                    ON CONFLICT (id) DO NOTHING`);
  // A listing, which is what used to divert the photos.
  await pool.query(
    `INSERT INTO profiles (id, user_id, type, category_id, package_tier, slug, display_name, status, free_gallery_credits)
     VALUES (9511, 610002, 'business', 9501, 'pro', 'listing-member', 'Listing Member Co', 'approved', 0),
            (9512, 610003, 'individual', 9501, 'basic', 'credit-member', 'Credit Member', 'approved', 1)`);
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
});

const ownerTypesOf = async (bundleId) => (await pool.query(
  'SELECT owner_type FROM gallery_images WHERE bundle_id = $1', [bundleId])).rows.map((r) => r.owner_type);

// ------------------------------------------------------ the destination

test('A GALLERY SUBMISSION FROM A MEMBER WITH A LISTING GOES TO THE GALLERY', async () => {
  // The exact case that broke: this member has a Directory listing.
  const { status, body } = await api('POST', '/gallery', { images: [img(1)] }, listingToken);
  assert.equal(status, 201);
  const types = await ownerTypesOf(body.bundle.id);
  assert.deepEqual(types, ['general'],
    'a Community Gallery submission is not a listing photo, whatever else the member owns');
});

test('and once approved it actually appears in the public Gallery', async () => {
  const { body } = await api('POST', '/gallery', { images: [img(2)] }, listingToken);
  await pool.query(`UPDATE gallery_images SET status = 'approved' WHERE bundle_id = $1`, [body.bundle.id]);

  const pub = await api('GET', '/gallery?page=1&limit=50');
  const ids = (await pool.query('SELECT id FROM gallery_images WHERE bundle_id = $1', [body.bundle.id])).rows.map((r) => r.id);
  assert.ok(pub.body.images.some((i) => ids.includes(i.id)),
    'approved, and visible — this is the whole bug');
});

test('a member with no listing is unaffected, as it always was', async () => {
  const { body } = await api('POST', '/gallery', { images: [img(3)] }, plainToken);
  assert.deepEqual(await ownerTypesOf(body.bundle.id), ['general']);
});

test('an explicit listing-photo submission still works for callers that ask for one', async () => {
  // The route still accepts ownerType — it is the member dashboard that
  // stopped sending it. Nothing else that uses this endpoint is broken.
  const { body } = await api('POST', '/gallery',
    { images: [img(4)], ownerType: 'profile', ownerId: 9511 }, listingToken);
  assert.deepEqual(await ownerTypesOf(body.bundle.id), ['profile']);
});

// ----------------------------------------------------------- the money

test('NOBODY HOLDING A FREE CREDIT GETS CHARGED', async () => {
  // The free-credit check used to sit behind the same owner_type condition as
  // the destination. Fixing one without the other would have started charging
  // R100 to a member who already had a credit.
  const before = await pool.query('SELECT free_gallery_credits FROM profiles WHERE id = 9512');
  assert.equal(before.rows[0].free_gallery_credits, 1, 'starts with one credit');

  const { status, body } = await api('POST', '/gallery', { images: [img(5)] }, creditToken);
  assert.equal(status, 201);
  assert.equal(body.bundle.status, 'pending',
    'pending, not awaiting_payment — the credit was spent instead of a charge');

  const after = await pool.query('SELECT free_gallery_credits FROM profiles WHERE id = 9512');
  assert.equal(after.rows[0].free_gallery_credits, 0, 'and the credit is actually used up');
});

test('once the credit is gone, the next one is payable', async () => {
  const { body } = await api('POST', '/gallery', { images: [img(6)] }, creditToken);
  assert.equal(body.bundle.status, 'awaiting_payment');
});

test('THE LISTING-PHOTO ALLOWANCE DOES NOT BECOME FREE GALLERY SUBMISSIONS', async () => {
  // A pro Business tier allows 3 LISTING photos. That must not quietly turn
  // into unlimited free Community Gallery bundles now that gallery
  // submissions no longer count against it.
  const { body } = await api('POST', '/gallery', { images: [img(7)] }, listingToken);
  assert.equal(body.bundle.status, 'awaiting_payment',
    'a Community Gallery submission is payable — the tier allowance is for listing photos');
});

test('but the allowance still applies to a genuine listing photo', async () => {
  const { body } = await api('POST', '/gallery',
    { images: [img(8)], ownerType: 'profile', ownerId: 9511 }, listingToken);
  assert.equal(body.bundle.status, 'pending', 'included in the pro tier, as before');
});

// ------------------------------------------------------------- the audit

test('THE AUDIT SAYS WHY A PHOTO IS NOT SHOWING', async () => {
  const { status, body } = await api('GET', '/gallery/admin/audit', null, adminToken);
  assert.equal(status, 200);
  assert.ok(body.total > 0);
  assert.ok(Object.prototype.hasOwnProperty.call(body, 'approvedButNotShowing'));
  body.images.forEach((i) => assert.ok(i.why, 'every photo gets a reason in words'));

  const showing = body.images.find((i) => i.shows_in_gallery);
  assert.match(showing.why, /Showing in the Community Gallery/);

  const pending = body.images.find((i) => i.status !== 'approved');
  assert.match(pending.why, /not approved yet/i);
});

test('it names a photo stranded on a listing, and whether the listing is live', async () => {
  await pool.query(`INSERT INTO profiles (id, user_id, type, category_id, package_tier, slug, display_name, status)
                    VALUES (9513, 610001, 'business', 9501, 'basic', 'hidden-co', 'Hidden Co', 'pending')`);
  await pool.query(`INSERT INTO gallery_images (owner_type, owner_id, image_url, status)
                    VALUES ('profile', 9513, 'https://example.test/stranded.jpg', 'approved')`);

  const { body } = await api('GET', '/gallery/admin/audit', null, adminToken);
  const stranded = body.images.find((i) => i.image_url.includes('stranded'));
  assert.equal(stranded.shows_in_gallery, false);
  assert.match(stranded.why, /appears NOWHERE/,
    'approved, on a listing that is not live either — the worst case, and it should say so');
  assert.ok(body.approvedButNotShowing >= 1);
});

test('the audit is admin-only and changes nothing', async () => {
  assert.equal((await api('GET', '/gallery/admin/audit', null, plainToken)).status, 403);
  assert.equal((await api('GET', '/gallery/admin/audit')).status, 401);

  const before = await pool.query('SELECT id, owner_type, status FROM gallery_images ORDER BY id');
  await api('GET', '/gallery/admin/audit', null, adminToken);
  const after = await pool.query('SELECT id, owner_type, status FROM gallery_images ORDER BY id');
  assert.deepEqual(after.rows, before.rows, 'read-only means read-only');
});
