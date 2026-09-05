// An admin creating a Directory listing directly — for a sponsor, business
// or person with no member account, and possibly none ever. Requested
// directly: "allow admin to add directory profiles manually. (admin must
// have full access to edit/delete/adjust)".
//
// This is the one real schema change involved: profiles.user_id was NOT NULL
// with a plain unique index (one listing per member, always), which made
// "create a listing with nobody behind it" impossible. 177_admin_created_
// profiles.sql makes the column nullable and switches the index to a
// partial one (unique only where user_id IS NOT NULL) — this file proves
// both halves of that: an admin-created listing can exist with no owner,
// AND a real member still cannot end up owning two listings.
//
// It also re-proves the two adminProfileLinks.js routes this touched:
// GET /admin/links/directory must now surface ownerless listings (it used
// to INNER JOIN users, which silently excluded anything with no owner), and
// POST .../revert must accept landing back on NULL as a real, legal outcome
// rather than treating it as "the account was deleted".
//
// Run with:  npm test   (from unplug-backend/)

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const jwt = require('jsonwebtoken');
const EmbeddedPostgres = require('embedded-postgres').default;
const { stopPostgres } = require('./helpers/stopPostgres');

let pg;
let pool;
let server;
let baseUrl;
let adminToken, memberToken;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-adminprofiles-'));
const port = 59200 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

async function req(method, urlPath, { token, body } = {}) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, body: json };
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
  process.env.JWT_SECRET = 'test-secret-for-admin-created-profiles';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }

  await pool.query(`INSERT INTO users (id, email, password_hash, role)
                    VALUES (1, 'admin@test.com', 'x', 'admin'),
                           (2, 'member@test.com', 'x', 'member'),
                           (3, 'other-member@test.com', 'x', 'member')
                    ON CONFLICT DO NOTHING`);
  adminToken = jwt.sign({ id: 1, email: 'admin@test.com', role: 'admin' }, process.env.JWT_SECRET);
  memberToken = jwt.sign({ id: 2, email: 'member@test.com', role: 'member' }, process.env.JWT_SECRET);

  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/admin', require('../src/routes/admin'));
  app.use('/admin/links', require('../src/routes/adminProfileLinks'));
  app.use('/', require('../src/routes/profiles')); // its own routes already include /profiles/* and /directory
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}, { timeout: 120000 });

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('A NON-ADMIN CANNOT CREATE A LISTING', async () => {
  const r = await req('POST', '/admin/profiles', {
    token: memberToken, body: { displayName: 'Should Fail', packageTier: 'basic' },
  });
  assert.equal(r.status, 403);
});

test('DISPLAY NAME IS REQUIRED', async () => {
  const r = await req('POST', '/admin/profiles', { token: adminToken, body: { packageTier: 'basic' } });
  assert.equal(r.status, 400);
});

test('PACKAGE TIER MUST BE ONE OF THE REAL THREE', async () => {
  const r = await req('POST', '/admin/profiles', {
    token: adminToken, body: { displayName: 'Bad Tier Co', packageTier: 'deluxe' },
  });
  assert.equal(r.status, 400);
});

let createdId, createdSlug;

test('AN ADMIN CREATES A STANDALONE LISTING — LIVE IMMEDIATELY, NO OWNER AT ALL', async () => {
  const r = await req('POST', '/admin/profiles', {
    token: adminToken,
    body: { displayName: 'Acme Sponsorship Co', type: 'business', packageTier: 'pro' },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.profile.status, 'approved', 'an admin-authored listing needs no approval queue');
  assert.equal(r.body.profile.user_id, null, 'this is the whole point — nobody owns it yet');
  assert.equal(r.body.profile.type, 'business');
  assert.ok(r.body.profile.slug);
  createdId = r.body.profile.id;
  createdSlug = r.body.profile.slug;

  // And it is really live — the ordinary public route serves it, same as
  // any member-submitted, approved listing.
  const pub = await req('GET', `/profiles/${createdSlug}`);
  assert.equal(pub.status, 200);
  assert.equal(pub.body.profile.display_name, 'Acme Sponsorship Co');
});

test('THE SAME REQUIREMENTS A MEMBER FILLS IN AT CHECKOUT ARE ACCEPTED HERE TOO — second category, location, street address for a Business Premium listing', async () => {
  const catRows = await pool.query(`SELECT id FROM categories WHERE type = 'directory' ORDER BY id LIMIT 2`);
  const [cat1, cat2] = catRows.rows;
  const r = await req('POST', '/admin/profiles', {
    token: adminToken,
    body: {
      displayName: 'Full Fields Business', type: 'business', packageTier: 'premium',
      categoryId: cat1.id, secondaryCategoryId: cat2.id,
      streetAddress: '1 Main Road', suburb: 'Sea Point', city: 'Cape Town', province: 'Western Cape', country: 'South Africa',
    },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.profile.category_id, cat1.id);
  assert.equal(r.body.profile.secondary_category_id, cat2.id, 'a Business Premium listing may have a second category, same as a member submission');
  assert.equal(r.body.profile.street_address, '1 Main Road');
  assert.equal(r.body.profile.suburb, 'Sea Point');
  assert.equal(r.body.profile.province, 'Western Cape');
});

test('A SECOND CATEGORY IS SILENTLY IGNORED WHEN THE TIER OR TYPE DOES NOT ALLOW IT — matches the member-facing rule exactly', async () => {
  const catRows = await pool.query(`SELECT id FROM categories WHERE type = 'directory' ORDER BY id LIMIT 2`);
  const [cat1, cat2] = catRows.rows;
  const notPremium = await req('POST', '/admin/profiles', {
    token: adminToken,
    body: { displayName: 'Business Not Premium', type: 'business', packageTier: 'pro', secondaryCategoryId: cat2.id },
  });
  assert.equal(notPremium.body.profile.secondary_category_id, null, 'Pro is not Premium, so no second category');

  const notBusiness = await req('POST', '/admin/profiles', {
    token: adminToken,
    body: { displayName: 'Individual Premium No Second Cat', type: 'individual', packageTier: 'premium', secondaryCategoryId: cat1.id },
  });
  assert.equal(notBusiness.body.profile.secondary_category_id, null, 'an individual never gets a second category, regardless of tier');
});

test('A DEMO REEL LINK IS ACCEPTED FOR AN INDIVIDUAL PREMIUM LISTING, IGNORED OTHERWISE', async () => {
  const allowed = await req('POST', '/admin/profiles', {
    token: adminToken,
    body: { displayName: 'Individual Premium With Reel', type: 'individual', packageTier: 'premium', demoReelUrl: 'https://youtube.com/watch?v=abc' },
  });
  assert.equal(allowed.body.profile.demo_reel_url, 'https://youtube.com/watch?v=abc');

  const ignored = await req('POST', '/admin/profiles', {
    token: adminToken,
    body: { displayName: 'Business Premium No Reel', type: 'business', packageTier: 'premium', demoReelUrl: 'https://youtube.com/watch?v=xyz' },
  });
  assert.equal(ignored.body.profile.demo_reel_url, null, 'a demo reel is an individual-only field, regardless of tier');
});

test('A STREET ADDRESS IS ONLY EVER STORED FOR A BUSINESS LISTING', async () => {
  const r = await req('POST', '/admin/profiles', {
    token: adminToken,
    body: { displayName: 'Individual With Street Attempt', type: 'individual', packageTier: 'basic', streetAddress: '5 Home Street' },
  });
  assert.equal(r.body.profile.street_address, null, 'an individual\'s address must never be captured or published, same as the member-facing rule');
});

test('A SECOND STANDALONE LISTING IS ALSO FINE — TWO NULL OWNERS DO NOT COLLIDE', async () => {
  const r = await req('POST', '/admin/profiles', {
    token: adminToken, body: { displayName: 'Second Sponsor Co', packageTier: 'basic' },
  });
  assert.equal(r.status, 201, 'the partial unique index must only govern REAL owners, not every NULL');
});

test('A DUPLICATE NAME GETS A DIFFERENT SLUG, NOT A 500', async () => {
  const r = await req('POST', '/admin/profiles', {
    token: adminToken, body: { displayName: 'Acme Sponsorship Co', packageTier: 'basic' },
  });
  assert.equal(r.status, 201);
  assert.notEqual(r.body.profile.slug, createdSlug);
});

test('THE ADMIN CAN EDIT IT WITH THE EXACT SAME ROUTE OWNERS USE — requireOwnerOrAdmin already lets admin through with no owner to compare against', async () => {
  const r = await req('PATCH', `/profiles/${createdId}`, {
    token: adminToken, body: { bio: 'A proud supporter of the Unplug community.' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.profile.bio, 'A proud supporter of the Unplug community.');
});

test('A MEMBER CANNOT EDIT AN OWNERLESS LISTING THEY DO NOT OWN', async () => {
  const r = await req('PATCH', `/profiles/${createdId}`, {
    token: memberToken, body: { bio: 'Hijacked.' },
  });
  assert.equal(r.status, 403);
});

test('GET /admin/links/directory NOW SURFACES THE OWNERLESS LISTING — it used to INNER JOIN users and silently drop these', async () => {
  const r = await req('GET', '/admin/links/directory?q=Acme Sponsorship', { token: adminToken });
  assert.equal(r.status, 200);
  const row = r.body.listings.find((l) => l.id === createdId);
  assert.ok(row, 'the ownerless listing must appear in the linking panel, not disappear from it');
  assert.equal(row.owner_email, null);
});

test('LINKING AN OWNERLESS LISTING TO A MEMBER WORKS — currentOwner starts as null, not a real user id', async () => {
  const r = await req('POST', `/admin/links/directory/${createdId}`, {
    token: adminToken, body: { userId: 2, reason: 'Their business now has an account.' },
  });
  assert.equal(r.status, 200);

  const after = await req('GET', `/admin/links/directory?q=Acme Sponsorship`, { token: adminToken });
  const row = after.body.listings.find((l) => l.id === createdId);
  assert.equal(row.owner_email, 'member@test.com');
});

test('REVERTING THAT LINK PUTS IT BACK TO NO OWNER — this must succeed, not be mistaken for "the account was deleted"', async () => {
  const r = await req('POST', `/admin/links/directory/${createdId}/revert`, {
    token: adminToken, body: { reason: 'Undo test' },
  });
  assert.equal(r.status, 200, r.body && r.body.error);

  const after = await req('GET', `/admin/links/directory?q=Acme Sponsorship`, { token: adminToken });
  const row = after.body.listings.find((l) => l.id === createdId);
  assert.equal(row.owner_email, null, 'this listing started with no owner, so reverting must land back on null');
});

test('A REAL MEMBER STILL CANNOT OWN TWO LISTINGS — the partial unique index still enforces that for real owners', async () => {
  // #3 (other-member@test.com) links to createdId, then a second listing
  // tries to link to the same account.
  await req('POST', `/admin/links/directory/${createdId}`, {
    token: adminToken, body: { userId: 3, reason: 'setup' },
  });
  const second = await req('POST', '/admin/profiles', {
    token: adminToken, body: { displayName: 'Third Sponsor Co', packageTier: 'basic' },
  });
  const clash = await req('POST', `/admin/links/directory/${second.body.profile.id}`, {
    token: adminToken, body: { userId: 3, reason: 'should collide' },
  });
  assert.equal(clash.status, 409);
});

test('DELETE REMOVES THE LISTING, AND A GONE ID IS A CLEAN 404', async () => {
  const gallery = await pool.query(
    `INSERT INTO gallery_images (owner_type, owner_id, image_url, status) VALUES ('profile', $1, 'https://example.test/a.jpg', 'approved') RETURNING id`,
    [createdId]
  );
  assert.equal(gallery.rowCount, 1);

  const r = await req('DELETE', `/admin/profiles/${createdId}`, { token: adminToken });
  assert.equal(r.status, 200);

  const gone = await pool.query('SELECT id FROM profiles WHERE id = $1', [createdId]);
  assert.equal(gone.rowCount, 0);
  const orphanGallery = await pool.query(`SELECT id FROM gallery_images WHERE owner_type = 'profile' AND owner_id = $1`, [createdId]);
  assert.equal(orphanGallery.rowCount, 0, 'its gallery images must be cleaned up too, not left as orphans');

  const again = await req('DELETE', `/admin/profiles/${createdId}`, { token: adminToken });
  assert.equal(again.status, 404);
});

test('A NON-ADMIN CANNOT DELETE A LISTING', async () => {
  const target = await req('POST', '/admin/profiles', {
    token: adminToken, body: { displayName: 'Protect Me Co', packageTier: 'basic' },
  });
  const r = await req('DELETE', `/admin/profiles/${target.body.profile.id}`, { token: memberToken });
  assert.equal(r.status, 403);
});
