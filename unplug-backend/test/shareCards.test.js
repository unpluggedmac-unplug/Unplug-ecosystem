// "AS FEATURED IN UNPLUG" SHARE CARDS — the approval gate.
//
// The masthead goes on these, so the guarantee is simple and absolute: NOBODY
// gets a clean card until an admin has approved it. Everything worth testing
// follows from that:
//
//   1. A pending card NEVER hands over the fields needed to draw it clean.
//      The gate has to be on the server, because the page can be edited by
//      whoever is looking at it.
//   2. A rejected card stays refused for ever.
//   3. A decision is made ONCE — a second approve is refused, so a card cannot
//      be re-approved after it was turned down.
//   4. Tokens are unguessable and per-card, so one link cannot be walked into
//      another.
//   5. A failing email never leaves a decision unrecorded.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-cards-'));
const port = 30400 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

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
  return jwt.sign({ id: userId, email: `sc${userId}@test.com`, role }, process.env.JWT_SECRET);
}

let _nextUserId = 231000;
async function makeUser(role = 'member') {
  const id = _nextUserId++;
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', $3) ON CONFLICT DO NOTHING`,
    [id, `sc${id}@test.com`, role]
  );
  return id;
}

async function submit(overrides = {}) {
  const res = await req('POST', '/share-cards', {
    body: {
      name: 'Naledi Mokoena', roleLine: 'Baker, Bo-Kaap',
      quote: 'We open at four in the morning.', category: 'Community Impact',
      format: 'post', submitterEmail: 'naledi@example.com',
      ...overrides,
    },
  });
  return res;
}

async function tokenOf(id) {
  const r = await pool.query('SELECT review_token FROM share_cards WHERE id = $1', [id]);
  return r.rows[0].review_token;
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
  process.env.JWT_SECRET = 'test-secret-for-share-cards';
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
  app.use('/share-cards', require('../src/routes/shareCards'));
  app.use('/admin/approval-queue', require('../src/routes/adminApprovalQueue'));
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

// ---------------------------------------------------------------------------
// Submitting
// ---------------------------------------------------------------------------

test('anyone can submit a card, and it lands as pending', async () => {
  const res = await submit();
  assert.equal(res.status, 201);
  const row = await pool.query('SELECT status, name FROM share_cards WHERE id = $1', [res.body.id]);
  assert.equal(row.rows[0].status, 'pending', 'nothing is ever created already approved');
  assert.equal(row.rows[0].name, 'Naledi Mokoena');
});

test('a card without a deliverable email is refused', async () => {
  // A card nobody can be given is not worth an admin's time reviewing.
  assert.equal((await submit({ submitterEmail: '' })).status, 400);
  assert.equal((await submit({ submitterEmail: 'not-an-address' })).status, 400);
});

test('a card without a name is refused', async () => {
  assert.equal((await submit({ name: '   ' })).status, 400);
});

test('an unknown format falls back rather than erroring', async () => {
  const res = await submit({ format: 'billboard' });
  assert.equal(res.status, 201);
  const row = await pool.query('SELECT format FROM share_cards WHERE id = $1', [res.body.id]);
  assert.equal(row.rows[0].format, 'post');
});

// ---------------------------------------------------------------------------
// THE GATE
// ---------------------------------------------------------------------------

test('A PENDING CARD NEVER HANDS OVER THE FIELDS TO DRAW IT CLEAN', async () => {
  // This is the whole feature. The page draws the card from these fields, so
  // withholding them IS the watermark — a check in the page could be edited
  // away by whoever is looking at it.
  const res = await submit();
  const token = await tokenOf(res.body.id);

  const fetched = await req('GET', `/share-cards/${token}`);
  assert.equal(fetched.status, 403);
  assert.equal(fetched.body.status, 'pending');
  assert.equal(fetched.body.card, undefined, 'NO CARD FIELDS MAY BE RETURNED BEFORE APPROVAL');
  assert.match(fetched.body.error, /still being checked/);
});

test('an approved card hands over its fields', async () => {
  const res = await submit({ name: 'Approved Person' });
  const token = await tokenOf(res.body.id);

  const decision = await req('PATCH', `/share-cards/admin/${res.body.id}/approve`, { token: adminToken });
  assert.equal(decision.status, 200);

  const fetched = await req('GET', `/share-cards/${token}`);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.card.name, 'Approved Person');
  assert.equal(fetched.body.card.status, 'approved');
});

test('A REJECTED CARD STAYS REFUSED', async () => {
  const res = await submit({ name: 'Rejected Person' });
  const token = await tokenOf(res.body.id);
  await req('PATCH', `/share-cards/admin/${res.body.id}/reject`, { token: adminToken });

  const fetched = await req('GET', `/share-cards/${token}`);
  assert.equal(fetched.status, 403);
  assert.equal(fetched.body.card, undefined);
});

test('a made-up token is a clean 404, not a database error', async () => {
  assert.equal((await req('GET', '/share-cards/not-a-token')).status, 404);
  assert.equal((await req('GET', '/share-cards/00000000-0000-0000-0000-000000000000')).status, 404);
});

test('every card gets its own unguessable token', async () => {
  const a = await submit();
  const b = await submit();
  const ta = await tokenOf(a.body.id);
  const tb = await tokenOf(b.body.id);
  assert.notEqual(ta, tb);
  assert.match(String(ta), /^[0-9a-f]{8}-[0-9a-f]{4}-/i, 'a uuid, not a sequential id somebody could walk');
});

// ---------------------------------------------------------------------------
// Deciding
// ---------------------------------------------------------------------------

test('A DECISION IS MADE ONCE — a second one is refused', async () => {
  const res = await submit();
  assert.equal((await req('PATCH', `/share-cards/admin/${res.body.id}/approve`, { token: adminToken })).status, 200);

  const again = await req('PATCH', `/share-cards/admin/${res.body.id}/approve`, { token: adminToken });
  assert.equal(again.status, 409);
  assert.match(again.body.error, /Already handled/);
});

test('a rejected card cannot then be approved', async () => {
  // Otherwise a mis-click could put the masthead on something already refused.
  const res = await submit();
  await req('PATCH', `/share-cards/admin/${res.body.id}/reject`, { token: adminToken });

  const flip = await req('PATCH', `/share-cards/admin/${res.body.id}/approve`, { token: adminToken });
  assert.equal(flip.status, 409);

  const row = await pool.query('SELECT status FROM share_cards WHERE id = $1', [res.body.id]);
  assert.equal(row.rows[0].status, 'rejected');
});

test('THE DECISION IS RECORDED EVEN WHEN THE EMAIL CANNOT BE SENT', async () => {
  // Email is not configured in this test environment, so sending genuinely
  // fails. A card left as 'pending' because a mail server was down would be
  // reviewed twice by an admin who could not tell it had already been done.
  const res = await submit({ name: 'Email Will Fail' });
  const decision = await req('PATCH', `/share-cards/admin/${res.body.id}/approve`, { token: adminToken });
  assert.equal(decision.status, 200);

  const row = await pool.query('SELECT status, reviewed_at, reviewed_by FROM share_cards WHERE id = $1', [res.body.id]);
  assert.equal(row.rows[0].status, 'approved');
  assert.ok(row.rows[0].reviewed_at, 'the decision is stamped whatever the mail server did');
  assert.ok(row.rows[0].reviewed_by, 'and attributed to the admin who made it');
});

test('deciding on a card that does not exist is a 404', async () => {
  assert.equal((await req('PATCH', '/share-cards/admin/999999/approve', { token: adminToken })).status, 404);
});

test('only an admin may decide', async () => {
  const res = await submit();
  const memberToken = tokenFor(await makeUser());
  assert.equal((await req('PATCH', `/share-cards/admin/${res.body.id}/approve`)).status, 401);
  assert.equal((await req('PATCH', `/share-cards/admin/${res.body.id}/approve`, { token: memberToken })).status, 403);
  assert.equal((await req('GET', '/share-cards/admin/all', { token: memberToken })).status, 403);
});

// ---------------------------------------------------------------------------
// It belongs in the one queue
// ---------------------------------------------------------------------------

test('A PENDING CARD APPEARS IN THE ADMIN APPROVAL QUEUE', async () => {
  // The point of rebuilding this instead of approving by emailed link: every
  // decision on the site is made in one place, with one audit trail.
  const res = await submit({ name: 'Queue Visible', roleLine: 'Potter, Clarens' });

  const queue = await req('GET', '/admin/approval-queue?type=share_card', { token: adminToken });
  assert.equal(queue.status, 200);
  const row = queue.body.items.find((i) => i.id === res.body.id);
  assert.ok(row, 'a card waiting for a decision must be in the queue');
  assert.equal(row.typeLabel, 'Share Card');
  assert.equal(row.title, 'Queue Visible');
  assert.equal(row.subtitle, 'Potter, Clarens');
  assert.equal(row.customerEmail, 'naledi@example.com');
  assert.equal(row.actions.approve.path, `/share-cards/admin/${res.body.id}/approve`);
  assert.ok(row.actions.reject, 'and refusing it is one click too');
});

test('a decided card leaves the queue', async () => {
  const res = await submit({ name: 'Leaves The Queue' });
  await req('PATCH', `/share-cards/admin/${res.body.id}/approve`, { token: adminToken });

  const queue = await req('GET', '/admin/approval-queue?type=share_card', { token: adminToken });
  assert.ok(!queue.body.items.some((i) => i.id === res.body.id),
    'a queue that keeps showing handled items stops being a to-do list');
});

test('the queue reports share cards among its types', async () => {
  const res = await req('GET', '/admin/approval-queue', { token: adminToken });
  const entry = res.body.types.find((t) => t.key === 'share_card');
  assert.ok(entry, 'the type filter must offer it');
  assert.equal(entry.label, 'Share Card');
  assert.equal(entry.group, 'content', 'a card is something to publish or refuse, not a payment');
});

test('re-running every migration is idempotent', async () => {
  const before = await pool.query('SELECT COUNT(*)::int AS n FROM share_cards');
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }
  const after = await pool.query('SELECT COUNT(*)::int AS n FROM share_cards');
  assert.equal(after.rows[0].n, before.rows[0].n, 'a re-deploy must not disturb submitted cards');
});
