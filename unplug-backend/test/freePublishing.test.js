// Free publishing for admins and consultants — articles, events and gallery
// bundles — over real HTTP against real PostgreSQL.
//
// The bug this guards against: the member-dashboard "Create & Pay" button
// used to call POST /payments/initiate after EVERY submission, regardless of
// whether the backend had already accepted it for free. A consultant
// submitting an article would be shown a real EFT reference and bank details
// for R95 that was never owed. The fix relies entirely on the frontend
// trusting the STATUS this API actually returns — so this file exists to pin
// that status (and the message describing it) is correct for every role, for
// every submission type that has a free path.
//
// events.js had a second, independent bug in the same family: its message
// was derived from hasCredit alone, not from publishesFree() — a consultant
// has no event credits (they're staff, not a paying member), so hasCredit was
// false for them even though their event was already 'pending' for free. The
// message told them to pay R300 for an event that needed no payment at all.
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
let consultantToken, adminToken, memberToken;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-freepub-'));
const port = 9600 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

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
  process.env.JWT_SECRET = 'test-secret-for-free-publishing';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }

  const jwt = require('jsonwebtoken');
  await pool.query(`INSERT INTO users (id, email, password_hash, role)
                    VALUES (1, 'admin@test.com', 'x', 'admin'),
                           (2, 'rep@unplugnews.com', 'x', 'consultant'),
                           (3, 'member@test.com', 'x', 'member')
                    ON CONFLICT DO NOTHING`);
  adminToken = jwt.sign({ id: 1, email: 'admin@test.com', role: 'admin' }, process.env.JWT_SECRET);
  consultantToken = jwt.sign({ id: 2, email: 'rep@unplugnews.com', role: 'consultant' }, process.env.JWT_SECRET);
  memberToken = jwt.sign({ id: 3, email: 'member@test.com', role: 'member' }, process.env.JWT_SECRET);

  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/articles', require('../src/routes/articles'));
  app.use('/events', require('../src/routes/events'));
  app.use('/gallery', require('../src/routes/gallery'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}, { timeout: 120000 });

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (pool) await pool.end();
  // stopPostgres, not pg.stop() directly: on Windows the library's stop
  // can HANG rather than throw, which used to leave the cluster running
  // with no parent and eventually broke a later test file's startup.
  // See test/helpers/stopPostgres.js.
  await stopPostgres(pg, dataDir);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ articles

test('a consultant\'s article is created pending, with a no-payment message', async () => {
  const r = await req('POST', '/articles', {
    token: consultantToken,
    body: { title: 'Client Feature', body: 'A story about a client.', bodyFormat: 'text' },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.article.status, 'pending', 'a consultant article should need approval, not payment');
  assert.match(r.body.message, /no payment needed/i);
  assert.doesNotMatch(r.body.message, /R95/, 'the message told a consultant to pay for a free article');
});

test('an admin\'s article publishes straight to live', async () => {
  const r = await req('POST', '/articles', {
    token: adminToken,
    body: { title: 'Editorial Piece', body: 'Staff-written.', bodyFormat: 'text' },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.article.status, 'approved');
  assert.match(r.body.message, /live on the site/i);
});

test('a paying member with no credit still owes for their article', async () => {
  const r = await req('POST', '/articles', {
    token: memberToken,
    body: { title: 'Member Story', body: 'A member wrote this.', bodyFormat: 'text' },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.article.status, 'awaiting_payment', 'a real paying member must still be asked to pay');
  assert.match(r.body.message, /payments\/initiate/);
});

// -------------------------------------------------------------------- events
//
// This is the exact bug: hasCredit-based messaging told a consultant to pay.

test('a consultant\'s event is pending, and the message does NOT ask them to pay', async () => {
  const r = await req('POST', '/events', {
    token: consultantToken,
    body: { name: 'Client Launch Party', eventDate: '2026-12-01' },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.event.status, 'pending', 'a consultant event should need approval, not payment');
  assert.match(r.body.message, /no payment needed/i);
  assert.doesNotMatch(r.body.message, /payments\/initiate/, 'a consultant was told to pay for an event already accepted free');
  assert.doesNotMatch(r.body.message, /R300/, 'the R300 fee was quoted to a consultant who owes nothing');
});

test('an admin\'s event is also free, published straight to live', async () => {
  // Admin gets 'approved' immediately, same as an admin article — editorial
  // staff publish straight through; a consultant still goes to 'pending' for
  // a second pair of eyes, since they act on a client's behalf.
  const r = await req('POST', '/events', {
    token: adminToken,
    body: { name: 'Staff Event', eventDate: '2026-12-05' },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.event.status, 'approved');
  assert.match(r.body.message, /live on the calendar/i);
  assert.doesNotMatch(r.body.message, /payments\/initiate/);
});

test('a paying member with no event credit still owes for their event', async () => {
  const r = await req('POST', '/events', {
    token: memberToken,
    body: { name: 'Member Meetup', eventDate: '2026-12-10' },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.event.status, 'awaiting_payment');
  assert.match(r.body.message, /payments\/initiate/);
  assert.match(r.body.message, /R300/);
});

// ------------------------------------------------------------------- gallery

test('a consultant\'s gallery bundle is pending, with a no-payment message', async () => {
  const r = await req('POST', '/gallery', {
    token: consultantToken,
    body: { images: [{ imageUrl: 'https://example.test/photo1.jpg' }] },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.bundle.status, 'pending', 'a consultant gallery bundle should need approval, not payment');
  assert.ok(r.body.images.every((i) => i.status === 'pending'), 'an individual photo was left awaiting payment');
  assert.match(r.body.message, /no payment needed/i);
});

test('a paying member with no gallery credit still owes for their bundle', async () => {
  const r = await req('POST', '/gallery', {
    token: memberToken,
    body: { images: [{ imageUrl: 'https://example.test/photo2.jpg' }] },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.bundle.status, 'awaiting_payment');
  assert.match(r.body.message, /payments\/initiate/);
});

// --------------------------------------------------- per-consultant toggle
//
// Requested directly: free publishing used to be all-or-nothing for the
// whole 'consultant' role. An admin can now revoke it from one specific
// person without demoting them out of the role — see
// 176_consultant_free_publishing_toggle.sql and publishingRights.js.

test('A CONSULTANT TOKEN WITH free_publishing_enabled:false IS BILLED LIKE A NORMAL MEMBER', async () => {
  const jwt = require('jsonwebtoken');
  const revokedToken = jwt.sign(
    { id: 2, email: 'rep@unplugnews.com', role: 'consultant', free_publishing_enabled: false },
    process.env.JWT_SECRET
  );
  const r = await req('POST', '/articles', {
    token: revokedToken,
    body: { title: 'No Longer Free', body: 'Free publishing was switched off for this one person.', bodyFormat: 'text' },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.article.status, 'awaiting_payment', 'with the toggle off, a consultant owes like any other member');
  assert.match(r.body.message, /payments\/initiate/);
});

test('AN OLDER TOKEN WITH NO free_publishing_enabled CLAIM AT ALL STILL PUBLISHES FREE — the column must default to allowed, not silently revoke everyone', async () => {
  // consultantToken (signed in `before` with no such claim) is exactly this
  // case, and its two tests above already prove it — this test exists so the
  // guarantee is stated explicitly, not just an accidental side effect of
  // token construction elsewhere in this file.
  const jwt = require('jsonwebtoken');
  const noClaimToken = jwt.sign({ id: 2, email: 'rep@unplugnews.com', role: 'consultant' }, process.env.JWT_SECRET);
  const r = await req('POST', '/articles', {
    token: noClaimToken,
    body: { title: 'Old Token Still Free', body: 'No free_publishing_enabled claim at all.', bodyFormat: 'text' },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.article.status, 'pending');
  assert.match(r.body.message, /no payment needed/i);
});

test('EXPLICITLY free_publishing_enabled:true BEHAVES IDENTICALLY TO NO CLAIM AT ALL', async () => {
  const jwt = require('jsonwebtoken');
  const explicitTrueToken = jwt.sign(
    { id: 2, email: 'rep@unplugnews.com', role: 'consultant', free_publishing_enabled: true },
    process.env.JWT_SECRET
  );
  const r = await req('POST', '/events', {
    token: explicitTrueToken,
    body: { name: 'Still Free Event', eventDate: '2026-12-15' },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.event.status, 'pending');
  assert.match(r.body.message, /no payment needed/i);
});

test('THE TOGGLE HAS NO EFFECT ON AN ADMIN — admins publish free regardless, per FREE_PUBLISHING_ROLES', async () => {
  const jwt = require('jsonwebtoken');
  const adminWithFlagOff = jwt.sign(
    { id: 1, email: 'admin@test.com', role: 'admin', free_publishing_enabled: false },
    process.env.JWT_SECRET
  );
  const r = await req('POST', '/articles', {
    token: adminWithFlagOff,
    body: { title: 'Admin Unaffected', body: 'The flag only means anything for a consultant.', bodyFormat: 'text' },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.article.status, 'approved', 'an admin is free regardless of this flag');
});
