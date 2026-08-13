// COMMENT MODERATION — nothing a member or visitor writes is public until an
// admin approves it.
//
// The guarantee is one sentence, so the tests are written to break it rather
// than to confirm it. Every comment surface on the site is covered:
//
//   content_comments      — articles, profiles, gallery images, events,
//                           marketplace posters (members, signed in)
//   deaf_passport_comments — passports (ANONYMOUS, no account required)
//
// The passport one is the reason this file exists. It had no status column at
// all and no moderation, and its POST takes no authentication — so anyone on
// the internet could put text straight onto a live public page.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-modcomment-'));
const port = 25600 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

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
  return jwt.sign({ id: userId, email: `cm${userId}@test.com`, role }, process.env.JWT_SECRET);
}

let _nextUserId = 141000;
async function makeUser(role = 'member') {
  const id = _nextUserId++;
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role, full_name)
     VALUES ($1, $2, 'x', $3, $4) ON CONFLICT DO NOTHING`,
    [id, `cm${id}@test.com`, role, `Member ${id}`]
  );
  return id;
}

let adminToken;
let memberId;
let articleId;
let passportId;

before(async () => {
  pg = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'postgres', password: 'postgres', port,
    persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('unplug_test');

  process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${port}/unplug_test`;
  process.env.JWT_SECRET = 'test-secret-for-comment-moderation';
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
  app.use('/comments', require('../src/routes/comments'));
  app.use('/deaf-community', require('../src/routes/deafCommunity'));
  app.use('/admin/approval-queue', require('../src/routes/adminApprovalQueue'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  adminToken = tokenFor(await makeUser('admin'), 'admin');
  memberId = await makeUser();

  const a = await pool.query(
    `INSERT INTO articles (author_user_id, title, body, status)
     VALUES ($1, 'Moderation Test Article', 'Body', 'approved') RETURNING id`,
    [memberId]
  );
  articleId = a.rows[0].id;

  const p = await pool.query(
    `INSERT INTO deaf_passports (name, email, skills, availability, status, expires_at)
     VALUES ('Passport Owner', 'po@test.com', 'Design', 'Immediately', 'approved', now() + interval '14 days')
     RETURNING id`
  );
  passportId = p.rows[0].id;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  if (pg) await pg.stop();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* Windows holds the dir briefly */ }
});

// --- Member comments --------------------------------------------------------

test('a new member comment is NOT public', async () => {
  const posted = await req('POST', `/comments/article/${articleId}`, {
    token: tokenFor(memberId), body: { body: 'This should not appear yet.' },
  });
  assert.equal(posted.status, 201);
  assert.match(posted.body.message, /review/i, 'the member must be told it is awaiting review');

  const publicView = await req('GET', `/comments/article/${articleId}`);
  assert.equal(publicView.status, 200);
  const bodies = (publicView.body.comments || []).map((c) => c.body);
  assert.ok(!bodies.includes('This should not appear yet.'), 'an unapproved comment must not be public');
});

test('a member comment becomes public only after an admin approves it', async () => {
  const posted = await req('POST', `/comments/article/${articleId}`, {
    token: tokenFor(memberId), body: { body: 'Approve me please.' },
  });
  const id = posted.body.comment.id;

  await req('PATCH', `/comments/${id}/status`, { token: adminToken, body: { status: 'approved' } });

  const publicView = await req('GET', `/comments/article/${articleId}`);
  const bodies = (publicView.body.comments || []).map((c) => c.body);
  assert.ok(bodies.includes('Approve me please.'), 'an approved comment should be public');
});

test('a rejected member comment never becomes public', async () => {
  const posted = await req('POST', `/comments/article/${articleId}`, {
    token: tokenFor(memberId), body: { body: 'Reject me.' },
  });
  await req('PATCH', `/comments/${posted.body.comment.id}/status`, {
    token: adminToken, body: { status: 'rejected' },
  });
  const publicView = await req('GET', `/comments/article/${articleId}`);
  const bodies = (publicView.body.comments || []).map((c) => c.body);
  assert.ok(!bodies.includes('Reject me.'));
});

test('a member cannot approve their own comment', async () => {
  const posted = await req('POST', `/comments/article/${articleId}`, {
    token: tokenFor(memberId), body: { body: 'Self approval attempt.' },
  });
  const res = await req('PATCH', `/comments/${posted.body.comment.id}/status`, {
    token: tokenFor(memberId), body: { status: 'approved' },
  });
  assert.equal(res.status, 403);

  const publicView = await req('GET', `/comments/article/${articleId}`);
  assert.ok(!(publicView.body.comments || []).map((c) => c.body).includes('Self approval attempt.'));
});

// --- Passport comments (anonymous — the hole this closed) -------------------

test('an anonymous passport comment is NOT public', async () => {
  const posted = await req('POST', `/deaf-community/passports/${passportId}/comments`, {
    body: { commenterName: 'A Stranger', comment: 'Anyone on the internet can send this.' },
  });
  assert.equal(posted.status, 201);
  assert.match(posted.body.message, /review/i, 'the poster must be told it is awaiting review');

  const publicView = await req('GET', `/deaf-community/passports/${passportId}/comments`);
  assert.equal(publicView.status, 200);
  assert.equal(publicView.body.comments.length, 0, 'nothing unapproved may be public');
});

test('a passport comment becomes public only after an admin approves it', async () => {
  await req('POST', `/deaf-community/passports/${passportId}/comments`, {
    body: { commenterName: 'A Friend', comment: 'Well done, this is wonderful.' },
  });
  const pending = await req('GET', '/deaf-community/admin/passport-comments/pending', { token: adminToken });
  const target = pending.body.comments.find((c) => c.comment === 'Well done, this is wonderful.');
  assert.ok(target, 'it should be waiting in the admin queue');

  await req('PATCH', `/deaf-community/admin/passport-comments/${target.id}/approve`, { token: adminToken });

  const publicView = await req('GET', `/deaf-community/passports/${passportId}/comments`);
  const comments = publicView.body.comments.map((c) => c.comment);
  assert.ok(comments.includes('Well done, this is wonderful.'));
});

test('a rejected passport comment never becomes public', async () => {
  await req('POST', `/deaf-community/passports/${passportId}/comments`, {
    body: { comment: 'Something abusive.' },
  });
  const pending = await req('GET', '/deaf-community/admin/passport-comments/pending', { token: adminToken });
  const target = pending.body.comments.find((c) => c.comment === 'Something abusive.');

  await req('PATCH', `/deaf-community/admin/passport-comments/${target.id}/reject`, { token: adminToken });

  const publicView = await req('GET', `/deaf-community/passports/${passportId}/comments`);
  assert.ok(!publicView.body.comments.map((c) => c.comment).includes('Something abusive.'));
});

test('passport comment moderation is admin-only', async () => {
  await req('POST', `/deaf-community/passports/${passportId}/comments`, { body: { comment: 'Guard test.' } });
  const pending = await req('GET', '/deaf-community/admin/passport-comments/pending', { token: adminToken });
  const target = pending.body.comments.find((c) => c.comment === 'Guard test.');

  assert.equal((await req('PATCH', `/deaf-community/admin/passport-comments/${target.id}/approve`)).status, 401);
  assert.equal((await req('PATCH', `/deaf-community/admin/passport-comments/${target.id}/approve`, {
    token: tokenFor(memberId),
  })).status, 403);
  assert.equal((await req('GET', '/deaf-community/admin/passport-comments/pending', {
    token: tokenFor(memberId),
  })).status, 403);

  // And it is still not public after those attempts.
  const publicView = await req('GET', `/deaf-community/passports/${passportId}/comments`);
  assert.ok(!publicView.body.comments.map((c) => c.comment).includes('Guard test.'));
});

// --- Both surfaces reach the one queue --------------------------------------

test('both kinds of pending comment appear in the Approval Queue', async () => {
  await req('POST', `/comments/article/${articleId}`, {
    token: tokenFor(memberId), body: { body: 'Queue visibility member comment.' },
  });
  await req('POST', `/deaf-community/passports/${passportId}/comments`, {
    body: { comment: 'Queue visibility passport comment.' },
  });

  const queue = await req('GET', '/admin/approval-queue?type=comment,passport_comment', { token: adminToken });
  assert.equal(queue.status, 200);
  assert.deepEqual(queue.body.problems, [], 'both source queries must run: ' + JSON.stringify(queue.body.problems));

  const titles = queue.body.items.map((i) => i.title);
  assert.ok(titles.some((t) => t.includes('Queue visibility member comment')));
  assert.ok(titles.some((t) => t.includes('Queue visibility passport comment')));

  // An anonymous poster has no account, so the queue must still name someone.
  const anon = queue.body.items.find((i) => i.type === 'passport_comment');
  assert.ok(anon.customerName, 'an anonymous comment still needs an attributed name');
});

test('approving from the queue uses the endpoint the server named', async () => {
  const posted = await req('POST', `/comments/article/${articleId}`, {
    token: tokenFor(memberId), body: { body: 'Approved via the queue.' },
  });
  const queue = await req('GET', '/admin/approval-queue?type=comment', { token: adminToken });
  const row = queue.body.items.find((i) => i.id === posted.body.comment.id);

  const res = await req(row.actions.approve.method, row.actions.approve.path, {
    token: adminToken, body: row.actions.approve.body,
  });
  assert.equal(res.status, 200);

  const publicView = await req('GET', `/comments/article/${articleId}`);
  assert.ok(publicView.body.comments.map((c) => c.body).includes('Approved via the queue.'));
});

test('re-running every migration is idempotent, and keeps comments unapproved', async () => {
  // Migration 111 sets existing comments to pending. Re-running it must not
  // flip an already-approved comment back, or an admin's review would be
  // silently undone on every deploy.
  const before = await pool.query(
    `SELECT COUNT(*)::int AS n FROM deaf_passport_comments WHERE status = 'approved'`
  );
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }
  const after = await pool.query(
    `SELECT COUNT(*)::int AS n FROM deaf_passport_comments WHERE status = 'approved'`
  );
  assert.equal(after.rows[0].n, before.rows[0].n, 'a re-run must not change any review decision');
});
