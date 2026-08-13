// Service cancellation requests (routes/cancellations.js).
//
// The guarantees worth testing hardest:
//   1. A member can NEVER stop their own paid service. Requesting must leave
//      it running; only an admin approval stops it. That is the entire point
//      of the feature.
//   2. A member cannot request cancellation of somebody else's service.
//   3. Approving stops the service IMMEDIATELY and, when the admin chose to
//      give money back, issues the credit in the SAME transaction — a
//      cancellation recorded as done with the service still live, or credit
//      issued for a service that never stopped, are both worse than failing.
//   4. Nothing is ever refunded automatically. The amount comes from the
//      admin or there is no refund.
//   5. The same payment cannot be handed back twice.
//   6. Rejecting leaves the service completely untouched.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-cancel-'));
const port = 24400 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

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
  return jwt.sign({ id: userId, email: `sc${userId}@test.com`, role }, process.env.JWT_SECRET);
}

let _nextUserId = 111000;
async function makeUser(role = 'member') {
  const id = _nextUserId++;
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role, full_name)
     VALUES ($1, $2, 'x', $3, $4) ON CONFLICT DO NOTHING`,
    [id, `sc${id}@test.com`, role, `Person ${id}`]
  );
  return id;
}

let _nextSlug = 0;
// A live Directory listing with a confirmed payment behind it — the ordinary
// case a member would want to cancel.
async function makeLiveListing(userId, name, { amount = 500 } = {}) {
  const p = await pool.query(
    `INSERT INTO profiles (user_id, type, package_tier, slug, display_name, status)
     VALUES ($1, 'business', 'pro', $2, $3, 'approved') RETURNING id`,
    [userId, `sc-listing-${_nextSlug++}`, name]
  );
  const profileId = p.rows[0].id;
  const pay = await pool.query(
    `INSERT INTO payments (user_id, amount, method, gateway_reference, status, linked_type, linked_id)
     VALUES ($1, $2, 'eft', $3, 'confirmed', 'profile_package', $4) RETURNING id`,
    [userId, amount, `SCREF${_nextSlug}${Math.random().toString(36).slice(2, 6).toUpperCase()}`, profileId]
  );
  return { profileId, paymentId: pay.rows[0].id };
}

async function listingStatus(profileId) {
  const r = await pool.query('SELECT status, cancelled_at FROM profiles WHERE id = $1', [profileId]);
  return r.rows[0];
}

async function creditBalance(userId) {
  const r = await pool.query('SELECT COALESCE(SUM(amount), 0) AS n FROM account_credits WHERE user_id = $1', [userId]);
  return Number(r.rows[0].n);
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

before(async () => {
  pg = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'postgres', password: 'postgres', port,
    persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('unplug_test');

  process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${port}/unplug_test`;
  process.env.JWT_SECRET = 'test-secret-for-cancellations';
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
  app.use('/cancellations', require('../src/routes/cancellations'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  adminToken = tokenFor(await makeUser('admin'), 'admin');
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  if (pg) await pg.stop();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* Windows holds the dir briefly */ }
});

test('requesting a cancellation does NOT stop the service', async () => {
  // The guarantee the whole feature rests on: asking is not cancelling.
  const userId = await makeUser();
  const { profileId } = await makeLiveListing(userId, 'Still Running Ltd');

  const res = await req('POST', '/cancellations', {
    token: tokenFor(userId),
    body: { serviceType: 'profile_package', serviceId: profileId, reason: 'Closing the business' },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.request.status, 'requested');

  const after = await listingStatus(profileId);
  assert.equal(after.status, 'approved', 'the listing must still be live');
  assert.equal(after.cancelled_at, null);
});

test('the request captures what was asked, when, and against which reference', async () => {
  const userId = await makeUser();
  const { profileId } = await makeLiveListing(userId, 'Captured Details Co');

  await req('POST', '/cancellations', {
    token: tokenFor(userId),
    body: {
      serviceType: 'profile_package', serviceId: profileId,
      reason: 'Moving overseas', requestedEffectiveDate: '2026-09-01',
    },
  });

  const mine = await req('GET', '/cancellations/mine', { token: tokenFor(userId) });
  const row = mine.body.requests[0];
  assert.equal(row.service_label, 'Captured Details Co');
  assert.equal(row.reason, 'Moving overseas');
  assert.ok(row.reference, 'the payment reference should be captured');
  assert.ok(row.service_submitted_at, 'the original submission date should be captured');
  assert.ok(row.requested_effective_date);
  assert.ok(row.created_at);
});

test('a member cannot request cancellation of someone else\'s service', async () => {
  const owner = await makeUser();
  const stranger = await makeUser();
  const { profileId } = await makeLiveListing(owner, 'Not Yours Ltd');

  const res = await req('POST', '/cancellations', {
    token: tokenFor(stranger),
    body: { serviceType: 'profile_package', serviceId: profileId },
  });
  assert.equal(res.status, 403);
});

test('the same service cannot have two open requests', async () => {
  const userId = await makeUser();
  const { profileId } = await makeLiveListing(userId, 'Double Request Ltd');
  const body = { serviceType: 'profile_package', serviceId: profileId };

  assert.equal((await req('POST', '/cancellations', { token: tokenFor(userId), body })).status, 201);
  const second = await req('POST', '/cancellations', { token: tokenFor(userId), body });
  assert.equal(second.status, 409);
});

test('approving stops the service immediately', async () => {
  const userId = await makeUser();
  const { profileId } = await makeLiveListing(userId, 'Stops Now Ltd');
  const created = await req('POST', '/cancellations', {
    token: tokenFor(userId), body: { serviceType: 'profile_package', serviceId: profileId },
  });

  const res = await req('PATCH', `/cancellations/admin/${created.body.request.id}`, {
    token: adminToken, body: { action: 'approve' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'cancelled');

  const after = await listingStatus(profileId);
  assert.equal(after.status, 'rejected', 'the listing must no longer be live');
  assert.ok(after.cancelled_at, 'cancelled_at distinguishes this from a listing we turned down');
});

test('no refund is issued unless the admin sets an amount', async () => {
  const userId = await makeUser();
  const { profileId } = await makeLiveListing(userId, 'No Refund Ltd');
  const created = await req('POST', '/cancellations', {
    token: tokenFor(userId), body: { serviceType: 'profile_package', serviceId: profileId },
  });

  await req('PATCH', `/cancellations/admin/${created.body.request.id}`, {
    token: adminToken, body: { action: 'approve' },
  });
  assert.equal(await creditBalance(userId), 0, 'nothing should be refunded automatically');
});

test('the admin-chosen refund amount is credited, and only that amount', async () => {
  const userId = await makeUser();
  const { profileId } = await makeLiveListing(userId, 'Partial Refund Ltd', { amount: 500 });
  const created = await req('POST', '/cancellations', {
    token: tokenFor(userId), body: { serviceType: 'profile_package', serviceId: profileId },
  });

  const res = await req('PATCH', `/cancellations/admin/${created.body.request.id}`, {
    token: adminToken, body: { action: 'approve', refundAmount: 200, adminNote: 'Half the term used' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.refundAmount, 200);
  assert.equal(await creditBalance(userId), 200, 'the admin figure, not the payment amount');
});

test('the same payment cannot be refunded twice', async () => {
  const userId = await makeUser();
  const { profileId, paymentId } = await makeLiveListing(userId, 'Already Credited Ltd');
  // Simulates the item having been declined-with-credit earlier.
  await pool.query(
    `INSERT INTO account_credits (user_id, amount, reason, note, payment_id)
     VALUES ($1, 300, 'declined_submission', 'Earlier credit', $2)`,
    [userId, paymentId]
  );

  const created = await req('POST', '/cancellations', {
    token: tokenFor(userId), body: { serviceType: 'profile_package', serviceId: profileId },
  });
  const res = await req('PATCH', `/cancellations/admin/${created.body.request.id}`, {
    token: adminToken, body: { action: 'approve', refundAmount: 200 },
  });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /already been credited/i);

  // And the rollback held: the service is still live and no extra credit exists.
  assert.equal((await listingStatus(profileId)).status, 'approved');
  assert.equal(await creditBalance(userId), 300);
});

test('rejecting leaves the service completely untouched', async () => {
  const userId = await makeUser();
  const { profileId } = await makeLiveListing(userId, 'Refused Cancellation Ltd');
  const created = await req('POST', '/cancellations', {
    token: tokenFor(userId), body: { serviceType: 'profile_package', serviceId: profileId },
  });

  const res = await req('PATCH', `/cancellations/admin/${created.body.request.id}`, {
    token: adminToken, body: { action: 'reject', adminNote: 'Outside the cancellation window' },
  });
  assert.equal(res.status, 200);

  const after = await listingStatus(profileId);
  assert.equal(after.status, 'approved');
  assert.equal(after.cancelled_at, null);
  assert.equal(await creditBalance(userId), 0);
});

test('a decided request cannot be decided again', async () => {
  const userId = await makeUser();
  const { profileId } = await makeLiveListing(userId, 'Decided Once Ltd');
  const created = await req('POST', '/cancellations', {
    token: tokenFor(userId), body: { serviceType: 'profile_package', serviceId: profileId },
  });
  const id = created.body.request.id;

  await req('PATCH', `/cancellations/admin/${id}`, { token: adminToken, body: { action: 'approve', refundAmount: 50 } });
  const again = await req('PATCH', `/cancellations/admin/${id}`, { token: adminToken, body: { action: 'approve', refundAmount: 50 } });
  assert.equal(again.status, 409);
  assert.equal(await creditBalance(userId), 50, 'the credit must not be issued twice');
});

test('marking under review changes nothing but the status', async () => {
  const userId = await makeUser();
  const { profileId } = await makeLiveListing(userId, 'Under Review Ltd');
  const created = await req('POST', '/cancellations', {
    token: tokenFor(userId), body: { serviceType: 'profile_package', serviceId: profileId },
  });

  const res = await req('PATCH', `/cancellations/admin/${created.body.request.id}`, {
    token: adminToken, body: { action: 'review' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'under_review');
  assert.equal((await listingStatus(profileId)).status, 'approved');
});

test('the member is offered only their own live, un-requested services', async () => {
  const userId = await makeUser();
  const other = await makeUser();
  const { profileId } = await makeLiveListing(userId, 'Cancellable Ltd');
  await makeLiveListing(other, 'Someone Elses Ltd');

  let res = await req('GET', '/cancellations/services', { token: tokenFor(userId) });
  assert.equal(res.status, 200);
  const labels = res.body.services.map((s) => s.label);
  assert.ok(labels.includes('Cancellable Ltd'));
  assert.ok(!labels.includes('Someone Elses Ltd'));

  // Once requested, it drops off the list rather than offering a second ask.
  await req('POST', '/cancellations', {
    token: tokenFor(userId), body: { serviceType: 'profile_package', serviceId: profileId },
  });
  res = await req('GET', '/cancellations/services', { token: tokenFor(userId) });
  assert.ok(!res.body.services.map((s) => s.label).includes('Cancellable Ltd'));
});

test('every approval is written to the audit log with the amount', async () => {
  const userId = await makeUser();
  const { profileId } = await makeLiveListing(userId, 'Audited Cancellation Ltd');
  const created = await req('POST', '/cancellations', {
    token: tokenFor(userId), body: { serviceType: 'profile_package', serviceId: profileId },
  });
  await req('PATCH', `/cancellations/admin/${created.body.request.id}`, {
    token: adminToken, body: { action: 'approve', refundAmount: 75 },
  });
  const row = await waitForLog('cancellation_approved');
  assert.ok(row);
  assert.match(row.details, /75/);
});

test('cancellation endpoints enforce sign-in and admin role', async () => {
  const memberToken = tokenFor(await makeUser('member'), 'member');
  assert.equal((await req('POST', '/cancellations', { body: { serviceType: 'profile_package', serviceId: 1 } })).status, 401);
  assert.equal((await req('GET', '/cancellations/mine')).status, 401);
  assert.equal((await req('GET', '/cancellations/admin', { token: memberToken })).status, 403);
  assert.equal((await req('PATCH', '/cancellations/admin/1', { token: memberToken, body: { action: 'approve' } })).status, 403);
});

test('an unknown service type is refused rather than guessed at', async () => {
  const userId = await makeUser();
  const res = await req('POST', '/cancellations', {
    token: tokenFor(userId), body: { serviceType: 'not_a_service', serviceId: 1 },
  });
  assert.equal(res.status, 404);
});

test('re-running every migration is idempotent', async () => {
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }
  const n = await pool.query('SELECT COUNT(*) AS n FROM service_cancellations');
  assert.ok(Number(n.rows[0].n) > 0, 'requests must survive a migration re-run');
});
