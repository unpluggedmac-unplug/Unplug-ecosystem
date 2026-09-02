// Asking a member to change specific fields, and getting it back (spec §10.14).
//
// The third answer an admin can give. Before this there were two — approve or
// reject — so a fixable submission had to be refused outright and the member
// had to start again without being told what was wrong.
//
// What these protect:
//
//   1. THE ROUND TRIP CLOSES. Requested -> member sees it -> resubmitted ->
//      back in the admin queue. A pathway that loses the submission at any
//      step is worse than not having it, because the member is now waiting.
//   2. ONE OPEN REQUEST AT A TIME. Two would mean the member seeing two lists
//      of what to fix and nobody able to say which was answered.
//   3. IT IS THEIR OWN WORK. A change request id is a small integer; guessing
//      one must not let somebody resubmit another member's submission.
//   4. ONLY FIELDS THAT EXIST. The list an admin may request is the same
//      whitelist they may edit, so nothing can name a column.

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
let adminToken;
let memberToken;
let otherToken;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-crq-'));
const port = 48400 + (process.pid % 300); // bases are 400 apart so ranges cannot overlap

async function api(method, urlPath, body, token) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

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
  process.env.JWT_SECRET = 'test-secret-for-change-requests';
  process.env.UNPLUG_DISABLE_RATE_LIMITS = '1';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(dir, f), 'utf8'));
  }

  const jwt = require('jsonwebtoken');
  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/admin/approval-queue', require('../src/routes/adminApprovalQueue'));
  app.use('/change-requests', require('../src/routes/changeRequests'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await pool.query(`INSERT INTO users (id, email, full_name, password_hash, role) VALUES
    (840001, 'admin@crq.test', 'CRQ Admin', 'x', 'admin'),
    (840002, 'member@crq.test', 'CRQ Member', 'x', 'member'),
    (840003, 'other@crq.test', 'Other Member', 'x', 'member')`);
  const sign = (id, role) => jwt.sign({ id, email: `${id}@crq.test`, role }, process.env.JWT_SECRET);
  adminToken = sign(840001, 'admin');
  memberToken = sign(840002, 'member');
  otherToken = sign(840003, 'member');
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
});

async function makeArticle(owner = 840002, status = 'pending') {
  const r = await pool.query(
    `INSERT INTO articles (author_user_id, title, body, status)
     VALUES ($1, 'A submission', 'Body text for the article.', $2) RETURNING id`,
    [owner, status]
  );
  return r.rows[0].id;
}
const statusOf = async (id) =>
  (await pool.query('SELECT status FROM articles WHERE id = $1', [id])).rows[0].status;

// ---------------------------------------------------------------------------

test('THE ROUND TRIP CLOSES: requested, seen, resubmitted, back in the queue', async () => {
  const id = await makeArticle();

  // 1. the admin asks for two specific fields
  const asked = await api('POST', `/admin/approval-queue/article/${id}/request-changes`,
    { fields: ['banner_image_url', 'title'], note: 'The cover is too dark.' }, adminToken);
  assert.equal(asked.status, 201, JSON.stringify(asked.body));
  assert.equal(await statusOf(id), 'changes_requested');

  // 2. the member is told, in the same words the admin ticked
  const mine = await api('GET', '/change-requests/mine', null, memberToken);
  assert.equal(mine.body.actionRequired, 1);
  const req0 = mine.body.changeRequests[0];
  assert.equal(req0.submissionId, id);
  assert.equal(req0.note, 'The cover is too dark.');
  assert.deepEqual(req0.fields.map((f) => f.col).sort(), ['banner_image_url', 'title']);
  assert.deepEqual(req0.fields.map((f) => f.label).sort(), ['Cover image', 'Title'],
    'the member sees the labels the admin saw, not column names');

  // 3. the member sends it back
  const back = await api('POST', `/change-requests/${req0.id}/resubmit`, {}, memberToken);
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.equal(await statusOf(id), 'resubmitted');

  // 4. and it is waiting on an admin again
  const queue = await api('GET', '/admin/approval-queue', null, adminToken);
  assert.ok((queue.body.items || []).some((i) => i.type === 'article' && Number(i.id) === id),
    'a resubmitted article must be back in front of an admin');

  // 5. and it is off the member's list
  const after = await api('GET', '/change-requests/mine', null, memberToken);
  assert.equal(after.body.actionRequired, 0);
});

test('ONE OPEN REQUEST AT A TIME', async () => {
  const id = await makeArticle();
  const first = await api('POST', `/admin/approval-queue/article/${id}/request-changes`,
    { fields: ['title'] }, adminToken);
  assert.equal(first.status, 201);

  const second = await api('POST', `/admin/approval-queue/article/${id}/request-changes`,
    { fields: ['body'] }, adminToken);
  assert.equal(second.status, 409, 'a second open request must be refused');

  const rows = await pool.query(
    `SELECT COUNT(*)::int AS n FROM change_requests
      WHERE submission_type = 'article' AND submission_id = $1 AND answered_at IS NULL`, [id]);
  assert.equal(rows.rows[0].n, 1);
});

test('a new request may be opened once the last was answered', async () => {
  // The history is kept; the index only stops two OPEN at once.
  const id = await makeArticle();
  const a = await api('POST', `/admin/approval-queue/article/${id}/request-changes`,
    { fields: ['title'] }, adminToken);
  await api('POST', `/change-requests/${a.body.changeRequest.id}/resubmit`, {}, memberToken);

  const b = await api('POST', `/admin/approval-queue/article/${id}/request-changes`,
    { note: 'Still not right.' }, adminToken);
  assert.equal(b.status, 201, 'a second round of changes must be possible');

  const all = await pool.query(
    `SELECT COUNT(*)::int AS n FROM change_requests WHERE submission_id = $1`, [id]);
  assert.equal(all.rows[0].n, 2, 'and the first request is kept as history');
});

// ------------------------------------------------------------- ownership

test('SOMEBODY ELSE CANNOT RESUBMIT YOUR WORK', async () => {
  const id = await makeArticle(840002);
  const asked = await api('POST', `/admin/approval-queue/article/${id}/request-changes`,
    { fields: ['title'] }, adminToken);

  const theft = await api('POST', `/change-requests/${asked.body.changeRequest.id}/resubmit`, {}, otherToken);
  assert.equal(theft.status, 403);
  assert.equal(await statusOf(id), 'changes_requested', 'and it stays where it was');
});

test('a member only sees their own change requests', async () => {
  const id = await makeArticle(840002);
  await api('POST', `/admin/approval-queue/article/${id}/request-changes`, { fields: ['title'] }, adminToken);

  const theirs = await api('GET', '/change-requests/mine', null, otherToken);
  assert.equal(theirs.body.changeRequests.some((c) => c.submissionId === id), false);
});

test('the member endpoints need a login', async () => {
  assert.equal((await api('GET', '/change-requests/mine')).status, 401);
  assert.equal((await api('POST', '/change-requests/1/resubmit')).status, 401);
});

test('requesting changes is admin-only', async () => {
  const id = await makeArticle();
  assert.equal(
    (await api('POST', `/admin/approval-queue/article/${id}/request-changes`,
      { fields: ['title'] }, memberToken)).status, 403);
});

// ------------------------------------------------------- what may be asked

test('ONLY FIELDS THAT ACTUALLY EXIST CAN BE REQUESTED', async () => {
  // The list is the approval queue's own editable whitelist, so a column that
  // cannot be edited cannot be requested — and nothing in a request names a
  // column that is not already known.
  const id = await makeArticle();
  const res = await api('POST', `/admin/approval-queue/article/${id}/request-changes`,
    { fields: ['title', 'status', 'author_user_id', 'DROP TABLE articles'], note: 'x' }, adminToken);
  assert.equal(res.status, 201);
  assert.deepEqual(res.body.changeRequest.fields, ['title'],
    'status, ids and nonsense are dropped, not stored');
});

test('a request has to say something', async () => {
  // No fields and no note tells the member their submission needs changing and
  // not what — which is worse than a plain rejection.
  const id = await makeArticle();
  const res = await api('POST', `/admin/approval-queue/article/${id}/request-changes`,
    { fields: [], note: '   ' }, adminToken);
  assert.equal(res.status, 400);
  assert.equal(await statusOf(id), 'pending', 'and nothing moved');
});

test('a note alone is enough', async () => {
  const id = await makeArticle();
  const res = await api('POST', `/admin/approval-queue/article/${id}/request-changes`,
    { note: 'Please shorten the standfirst.' }, adminToken);
  assert.equal(res.status, 201);
  assert.deepEqual(res.body.changeRequest.fields, []);
});

test('a kind of submission with nobody to hand it back to is refused, with the reason', async () => {
  // A gallery image belongs to a bundle and a share card is submitted without
  // an account. Saying so beats a silent 404.
  const res = await api('POST', '/admin/approval-queue/gallery/1/request-changes',
    { note: 'x' }, adminToken);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /cannot be sent back/);
  assert.match(res.body.error, /bundle/);
});

test('an unknown submission type is a 404, not a crash', async () => {
  assert.equal((await api('POST', '/admin/approval-queue/nonsense/1/request-changes',
    { note: 'x' }, adminToken)).status, 404);
});

test('a submission that does not exist cannot be sent back', async () => {
  const res = await api('POST', '/admin/approval-queue/article/999999/request-changes',
    { note: 'x' }, adminToken);
  assert.equal(res.status, 404);
});

test('resubmitting twice is refused', async () => {
  const id = await makeArticle();
  const asked = await api('POST', `/admin/approval-queue/article/${id}/request-changes`,
    { fields: ['title'] }, adminToken);
  const crId = asked.body.changeRequest.id;
  assert.equal((await api('POST', `/change-requests/${crId}/resubmit`, {}, memberToken)).status, 200);
  assert.equal((await api('POST', `/change-requests/${crId}/resubmit`, {}, memberToken)).status, 409);
});

test('the admin who asked is on the record', async () => {
  const id = await makeArticle();
  await api('POST', `/admin/approval-queue/article/${id}/request-changes`,
    { fields: ['title'] }, adminToken);
  const r = await pool.query(
    `SELECT requested_by FROM change_requests WHERE submission_id = $1 ORDER BY id DESC LIMIT 1`, [id]);
  assert.equal(r.rows[0].requested_by, 840001);
});
