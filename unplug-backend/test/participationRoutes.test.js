// Participation Engine — Stage F: the HTTP layer, over real HTTP against
// real PostgreSQL. Only src/routes/participation.js is mounted (the same
// pattern every other route test in this codebase uses — src/app.js
// can't be required directly in tests, it calls .listen() and starts a
// birthday-email interval on load). The underlying SQL functions
// themselves are already covered by the Stage A-E test files; these
// tests exercise route wiring, request validation, and auth boundaries.
//
// Run with:  npm test   (from unplug-backend/)

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const EmbeddedPostgres = require('embedded-postgres').default;
const { stopPostgres } = require('./helpers/stopPostgres');

let pg;
let pool;
let server;
let baseUrl;
let adminToken;
let memberAToken;
let memberBToken;
let memberAId;
let memberBId;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-participation-routes-'));
const port = 12000 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

function migrationFiles() {
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
    .map((f) => path.join(dir, f));
}
async function runMigrations() {
  for (const file of migrationFiles()) {
    await pool.query(fs.readFileSync(file, 'utf8'));
  }
}

async function req(method, urlPath, { token, body } = {}) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* no body, e.g. 204 */ }
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
  process.env.JWT_SECRET = 'test-secret-for-participation-routes';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await runMigrations();

  await pool.query(`
    INSERT INTO participation_actions (code, label, category_code, base_points, unique_per_object)
    VALUES ('test_http_action', 'Test HTTP Action', 'contribution', 12, FALSE)
    ON CONFLICT (code) DO NOTHING
  `);

  const jwt = require('jsonwebtoken');
  await pool.query(`INSERT INTO users (id, email, password_hash, role)
                    VALUES (1, 'admin@test.com', 'x', 'admin'),
                           (2, 'membera@test.com', 'x', 'member'),
                           (3, 'memberb@test.com', 'x', 'member')
                    ON CONFLICT DO NOTHING`);
  adminToken = jwt.sign({ id: 1, email: 'admin@test.com', role: 'admin' }, process.env.JWT_SECRET);
  memberAToken = jwt.sign({ id: 2, email: 'membera@test.com', role: 'member' }, process.env.JWT_SECRET);
  memberBToken = jwt.sign({ id: 3, email: 'memberb@test.com', role: 'member' }, process.env.JWT_SECRET);
  memberAId = 2;
  memberBId = 3;

  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/participation', require('../src/routes/participation'));
  app.use((req, res) => res.status(404).json({ error: 'not found' }));
  app.use((err, req, res, next) => { res.status(500).json({ error: err.message }); });

  server = app.listen(0);
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  server.close();
  await pool.end();
  // stopPostgres, not pg.stop() directly: on Windows the library's stop
  // can HANG rather than throw, which used to leave the cluster running
  // with no parent and eventually broke a later test file's startup.
  // See test/helpers/stopPostgres.js.
  await stopPostgres(pg, dataDir);
});

test('GET /participation/status-levels is public and returns the 6-tier ladder', async () => {
  const { status, body } = await req('GET', '/participation/status-levels');
  assert.equal(status, 200);
  assert.equal(body.statusLevels.length, 6);
  assert.equal(body.statusLevels[0].code, 'explorer');
});

test('GET /participation/recognition-types is public and returns all 11 badges', async () => {
  const { status, body } = await req('GET', '/participation/recognition-types');
  assert.equal(status, 200);
  assert.equal(body.recognitionTypes.length, 11);
});

test('GET /participation/leaderboard falls back to overall for an invalid type instead of erroring', async () => {
  const { status, body } = await req('GET', '/participation/leaderboard?type=not_a_real_type');
  assert.equal(status, 200);
  assert.equal(body.type, 'overall');
  assert.ok(Array.isArray(body.leaderboard));
});

test('GET /participation/homepage is public and returns a shaped payload even with no data yet', async () => {
  const { status, body } = await req('GET', '/participation/homepage');
  assert.equal(status, 200);
  assert.ok('day_theme' in body);
  assert.ok('todays_person' in body);
});

test('POST /participation/action requires authentication', async () => {
  const { status } = await req('POST', '/participation/action', { body: { actionCode: 'test_http_action' } });
  assert.equal(status, 401);
});

test('POST /participation/action requires actionCode in the body', async () => {
  const { status, body } = await req('POST', '/participation/action', { token: memberAToken, body: {} });
  assert.equal(status, 400);
  assert.match(body.error, /actionCode/);
});

test('POST /participation/action awards points for a real action and reports mission progress', async () => {
  const { status, body } = await req('POST', '/participation/action', {
    token: memberAToken, body: { actionCode: 'test_http_action' },
  });
  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(body.pointsEarned, 12);
  assert.equal(typeof body.missionsCompleted, 'number');
});

test('POST /participation/action reports a blocked reason for an unknown action, not an error', async () => {
  const { status, body } = await req('POST', '/participation/action', {
    token: memberAToken, body: { actionCode: 'totally_made_up' },
  });
  assert.equal(status, 200);
  assert.equal(body.success, false);
  assert.equal(body.blockedReason, 'action_not_found_or_disabled');
});

test('GET /participation/dashboard requires authentication', async () => {
  const { status } = await req('GET', '/participation/dashboard');
  assert.equal(status, 401);
});

test('GET /participation/dashboard creates a participation profile on first visit and returns a full payload', async () => {
  const { status, body } = await req('GET', '/participation/dashboard', { token: memberAToken });
  assert.equal(status, 200);
  assert.match(body.profile.referral_code, /^UNPLUG-[A-Z0-9]{6}$/);
  assert.ok(body.score);
  assert.ok(Array.isArray(body.achievements));
  assert.ok(Array.isArray(body.passport));
  assert.ok(Array.isArray(body.todayMissions));
  assert.ok(Array.isArray(body.rankings));
  assert.ok(Array.isArray(body.notifications));
});

test('POST /participation/referrals/register requires a referralCode', async () => {
  const { status, body } = await req('POST', '/participation/referrals/register', { token: memberBToken, body: {} });
  assert.equal(status, 400);
  assert.match(body.error, /referralCode/);
});

test('referral flow: A refers B, B registers via the HTTP route, and both sides reflect it', async () => {
  const dash = await req('GET', '/participation/dashboard', { token: memberAToken });
  const code = dash.body.profile.referral_code;

  const register = await req('POST', '/participation/referrals/register', { token: memberBToken, body: { referralCode: code } });
  assert.equal(register.status, 201);
  assert.equal(register.body.success, true);
  assert.equal(register.body.pointsEarnedByReferrer, 20);

  const mine = await req('GET', '/participation/referrals', { token: memberAToken });
  assert.equal(mine.status, 200);
  assert.equal(mine.body.totalRegistered, 1);
  assert.equal(mine.body.totalQualified, 0);
});

test('POST /participation/recognitions requires toUserId and recognitionType', async () => {
  const { status, body } = await req('POST', '/participation/recognitions', { token: memberAToken, body: { toUserId: memberBId } });
  assert.equal(status, 400);
  assert.match(body.error, /recognitionType/);
});

test('recognition flow over HTTP: give, then see it on the public list', async () => {
  const give = await req('POST', '/participation/recognitions', {
    token: memberAToken, body: { toUserId: memberBId, recognitionType: 'outstanding', message: 'Nice work' },
  });
  assert.equal(give.status, 201);
  assert.equal(give.body.success, true);

  const list = await req('GET', `/participation/recognitions/${memberBId}`);
  assert.equal(list.status, 200);
  assert.ok(list.body.recognitions.some((r) => r.recognition_type === 'outstanding'));
});

test('a duplicate recognition of the same type is rejected with a clear reason', async () => {
  const { status, body } = await req('POST', '/participation/recognitions', {
    token: memberAToken, body: { toUserId: memberBId, recognitionType: 'outstanding' },
  });
  assert.equal(status, 400);
  assert.equal(body.error, 'already_recognised_this_type');
});

test('POST /participation/notifications/read marks unread notifications read', async () => {
  const before1 = await req('GET', '/participation/dashboard', { token: memberBToken });
  assert.ok(before1.body.notifications.some((n) => n.is_read === false));

  const mark = await req('POST', '/participation/notifications/read', { token: memberBToken, body: {} });
  assert.equal(mark.status, 204);

  const after1 = await req('GET', '/participation/dashboard', { token: memberBToken });
  assert.ok(after1.body.notifications.every((n) => n.is_read === true));
});

test('admin-only routes reject a non-admin member', async () => {
  const { status } = await req('POST', '/participation/admin/award-points', {
    token: memberAToken, body: { userId: memberBId, points: 50, reason: 'test' },
  });
  assert.equal(status, 403);
});

test('admin can award and then reverse points', async () => {
  const award = await req('POST', '/participation/admin/award-points', {
    token: adminToken, body: { userId: memberBId, points: 250, reason: 'goodwill' },
  });
  assert.equal(award.status, 200);
  assert.equal(award.body.success, true);

  const tx = await pool.query(
    `SELECT id FROM participation_points WHERE user_id = $1 AND source = 'admin' ORDER BY id DESC LIMIT 1`,
    [memberBId]
  );
  const reverse = await req('POST', '/participation/admin/reverse-points', {
    token: adminToken, body: { txId: tx.rows[0].id, reason: 'correction' },
  });
  assert.equal(reverse.status, 204);

  const reverseAgain = await req('POST', '/participation/admin/reverse-points', {
    token: adminToken, body: { txId: tx.rows[0].id, reason: 'correction again' },
  });
  assert.equal(reverseAgain.status, 400);
});

test('admin can trigger a full resync for a member', async () => {
  const { status, body } = await req('POST', `/participation/admin/sync/${memberAId}`, { token: adminToken });
  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(typeof body.achievementsAwarded, 'number');
});

test('admin sponsor campaign CRUD + reporting over HTTP', async () => {
  const sponsorship = await pool.query(
    `INSERT INTO sponsorships (sponsor_name) VALUES ('HTTP Test Brand') RETURNING id`
  );

  const create = await req('POST', '/participation/admin/sponsor-campaigns', {
    token: adminToken,
    body: {
      sponsorshipId: sponsorship.rows[0].id,
      campaignType: 'homepage',
      campaignLabel: 'Presented by HTTP Test Brand',
      placementCode: 'http_test_placement',
      startsAt: '2026-01-01',
      endsAt: '2026-12-31',
    },
  });
  assert.equal(create.status, 201);
  const campaignId = create.body.id;

  const list = await req('GET', '/participation/admin/sponsor-campaigns', { token: adminToken });
  assert.ok(list.body.campaigns.some((c) => c.id === campaignId));

  const active = await req('GET', '/participation/homepage/sponsor/http_test_placement');
  assert.equal(active.body.sponsor.sponsor_name, 'HTTP Test Brand');

  await req('POST', `/participation/sponsor/${campaignId}/track`, { body: { eventType: 'impression' } });
  const report = await req('GET', `/participation/admin/sponsor-campaigns/${campaignId}/report`, { token: adminToken });
  assert.equal(report.status, 200);
  assert.equal(report.body.report.total_impressions, '1');
});

test('POST /participation/admin/sponsorships requires sponsorName and rejects non-admins', async () => {
  const missingField = await req('POST', '/participation/admin/sponsorships', { token: adminToken, body: {} });
  assert.equal(missingField.status, 400);

  const nonAdmin = await req('POST', '/participation/admin/sponsorships', { token: memberAToken, body: { sponsorName: 'X' } });
  assert.equal(nonAdmin.status, 403);
});

test('a sponsorship created via HTTP can immediately be used to create a campaign, without a direct DB insert', async () => {
  const create = await req('POST', '/participation/admin/sponsorships', {
    token: adminToken,
    body: { sponsorName: 'End-to-End Brand', sponsorUrl: 'https://example.com' },
  });
  assert.equal(create.status, 201);
  const sponsorshipId = create.body.id;

  const list = await req('GET', '/participation/admin/sponsorships', { token: adminToken });
  assert.ok(list.body.sponsorships.some((s) => s.id === sponsorshipId && s.sponsor_name === 'End-to-End Brand'));

  const campaign = await req('POST', '/participation/admin/sponsor-campaigns', {
    token: adminToken,
    body: {
      sponsorshipId,
      campaignType: 'homepage',
      campaignLabel: 'Presented by End-to-End Brand',
      placementCode: 'e2e_test_placement',
      startsAt: '2026-01-01',
      endsAt: '2026-12-31',
    },
  });
  assert.equal(campaign.status, 201);
});

test('PATCH /participation/admin/sponsor-campaigns/:id can pause/resume a campaign and edit its details', async () => {
  const sponsorship = await pool.query(`INSERT INTO sponsorships (sponsor_name) VALUES ('Patch Test Brand') RETURNING id`);
  const create = await req('POST', '/participation/admin/sponsor-campaigns', {
    token: adminToken,
    body: {
      sponsorshipId: sponsorship.rows[0].id, campaignType: 'homepage',
      campaignLabel: 'Original Label', placementCode: 'patch_test_placement',
      startsAt: '2026-01-01', endsAt: '2026-12-31',
    },
  });
  const campaignId = create.body.id;

  const pause = await req('PATCH', `/participation/admin/sponsor-campaigns/${campaignId}`, {
    token: adminToken, body: { isActive: false },
  });
  assert.equal(pause.status, 204);
  const afterPause = await req('GET', '/participation/homepage/sponsor/patch_test_placement');
  assert.equal(afterPause.body.sponsor, null); // inactive campaign no longer shows as the active sponsor

  const relabel = await req('PATCH', `/participation/admin/sponsor-campaigns/${campaignId}`, {
    token: adminToken, body: { campaignLabel: 'Updated Label', isActive: true },
  });
  assert.equal(relabel.status, 204);
  const list = await req('GET', '/participation/admin/sponsor-campaigns', { token: adminToken });
  const updated = list.body.campaigns.find((c) => c.id === campaignId);
  assert.equal(updated.campaign_label, 'Updated Label');
  assert.equal(updated.is_active, true);
});

test('PATCH /participation/admin/sponsor-campaigns/:id rejects an empty body and an unknown id', async () => {
  const sponsorship = await pool.query(`INSERT INTO sponsorships (sponsor_name) VALUES ('Patch Test Brand 2') RETURNING id`);
  const create = await req('POST', '/participation/admin/sponsor-campaigns', {
    token: adminToken,
    body: {
      sponsorshipId: sponsorship.rows[0].id, campaignType: 'homepage',
      campaignLabel: 'X', placementCode: 'patch_test_placement_2',
      startsAt: '2026-01-01', endsAt: '2026-12-31',
    },
  });

  const empty = await req('PATCH', `/participation/admin/sponsor-campaigns/${create.body.id}`, { token: adminToken, body: {} });
  assert.equal(empty.status, 400);

  const unknown = await req('PATCH', '/participation/admin/sponsor-campaigns/999999', { token: adminToken, body: { isActive: false } });
  assert.equal(unknown.status, 404);
});

test('DELETE /participation/admin/sponsor-campaigns/:id removes the campaign and rejects non-admins', async () => {
  const sponsorship = await pool.query(`INSERT INTO sponsorships (sponsor_name) VALUES ('Delete Test Brand') RETURNING id`);
  const create = await req('POST', '/participation/admin/sponsor-campaigns', {
    token: adminToken,
    body: {
      sponsorshipId: sponsorship.rows[0].id, campaignType: 'homepage',
      campaignLabel: 'To Delete', placementCode: 'delete_test_placement',
      startsAt: '2026-01-01', endsAt: '2026-12-31',
    },
  });
  const campaignId = create.body.id;

  const nonAdmin = await req('DELETE', `/participation/admin/sponsor-campaigns/${campaignId}`, { token: memberAToken });
  assert.equal(nonAdmin.status, 403);

  const del = await req('DELETE', `/participation/admin/sponsor-campaigns/${campaignId}`, { token: adminToken });
  assert.equal(del.status, 204);

  const list = await req('GET', '/participation/admin/sponsor-campaigns', { token: adminToken });
  assert.ok(!list.body.campaigns.some((c) => c.id === campaignId));

  const again = await req('DELETE', `/participation/admin/sponsor-campaigns/${campaignId}`, { token: adminToken });
  assert.equal(again.status, 404);
});
