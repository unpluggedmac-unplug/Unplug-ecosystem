// A member who submitted a Deaf Community vacancy or Opportunity Passport
// had no way to see, edit, renew or remove it afterwards — neither table has
// a user_id (submitting has never required an account, which matters for an
// accessibility-focused feature and stays that way), and no route existed
// for the owner at all. Only an admin could touch it, and only to approve or
// reject.
//
// Website remediation punch-list (2026-09-03), PASSPORT-002/DEAF-003.
//
// Fixed the same way editions solves "prove it's yours without an account":
// a random token, minted lazily and emailed on request. Tested here against
// jobs; passports share the exact same route factories, parameterised by
// table, so the same behaviour applies to both — see the parity test at the
// bottom for passports specifically.
//
// Run with:  npm test   (from unplug-backend/)

const { test, before, after, beforeEach } = require('node:test');
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-deafself-'));
const port = 26000 + (process.pid % 300); // bases 400 apart across test files

const outbox = [];

async function req(method, urlPath, { body } = {}) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
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

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }

  // Stub the mailer so a request-link call is provable without a real
  // provider — mirrors the pattern used by test/checkoutRecovery.test.js.
  const emailUtil = require('../src/utils/email');
  emailUtil.sendEmail = async (msg) => { outbox.push(msg); return { id: 'test' }; };

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/deaf-community', require('../src/routes/deafCommunity'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await pool.end();
  await stopPostgres(pg, dataDir);
});

beforeEach(() => { outbox.length = 0; });

let ref = 0;
async function makeApprovedJob(email = 'employer@test.com') {
  ref += 1;
  const r = await pool.query(
    `INSERT INTO deaf_jobs (business_name, title, description, apply_email, deaf_friendly_agreed, status)
     VALUES ('Test Co', $1, 'A real vacancy.', $2, true, 'approved') RETURNING id, manage_token`,
    [`Role ${ref}`, email]
  );
  return r.rows[0];
}

// For tests about what the manage routes DO, not about minting itself — a
// real token already in place, same as a listing whose owner has already
// requested their link at least once.
async function makeApprovedJobWithToken(email = 'employer@test.com') {
  const job = await makeApprovedJob(email);
  const token = `test-token-${job.id}-${Date.now()}`;
  await pool.query(`UPDATE deaf_jobs SET manage_token = $1 WHERE id = $2`, [token, job.id]);
  return { ...job, manage_token: token };
}

test('REQUESTING A LINK FOR AN UNKNOWN EMAIL ANSWERS THE SAME AS FOR A KNOWN ONE', async () => {
  const known = await req('POST', '/deaf-community/jobs/manage-link', { body: { email: 'nobody-has-this@test.com' } });
  await makeApprovedJob('someone@test.com');
  const unknown = await req('POST', '/deaf-community/jobs/manage-link', { body: { email: 'someone@test.com' } });
  assert.equal(known.status, 200);
  assert.equal(unknown.status, 200);
  assert.equal(known.body.message, unknown.body.message, 'the response must not reveal whether a match exists');
});

test('A REAL SUBMITTER GETS AN EMAILED LINK THAT ACTUALLY WORKS', async () => {
  await makeApprovedJob('worksforme@test.com');
  const r = await req('POST', '/deaf-community/jobs/manage-link', { body: { email: 'worksforme@test.com' } });
  assert.equal(r.status, 200);
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].to, 'worksforme@test.com');
  const m = outbox[0].text.match(/token=([a-f0-9]+)/);
  assert.ok(m, 'the email should contain a real manage link');

  const managed = await req('GET', `/deaf-community/jobs/manage/${m[1]}`);
  assert.equal(managed.status, 200);
  assert.equal(managed.body.job.apply_email, 'worksforme@test.com');
});

test('MULTIPLE LISTINGS FOR ONE EMAIL PRODUCE ONE EMAIL WITH SEVERAL LINKS, NOT SEVERAL EMAILS', async () => {
  await makeApprovedJob('busy@test.com');
  await makeApprovedJob('busy@test.com');
  await makeApprovedJob('busy@test.com');
  await req('POST', '/deaf-community/jobs/manage-link', { body: { email: 'busy@test.com' } });
  assert.equal(outbox.length, 1);
  const tokens = [...outbox[0].text.matchAll(/token=([a-f0-9]+)/g)];
  assert.equal(tokens.length, 3);
});

test('THE TOKEN IS MINTED ONCE AND REUSED, NOT REGENERATED EVERY REQUEST', async () => {
  await makeApprovedJob('samelink@test.com');
  await req('POST', '/deaf-community/jobs/manage-link', { body: { email: 'samelink@test.com' } });
  const first = outbox[0].text.match(/token=([a-f0-9]+)/)[1];
  await req('POST', '/deaf-community/jobs/manage-link', { body: { email: 'samelink@test.com' } });
  const second = outbox[1].text.match(/token=([a-f0-9]+)/)[1];
  assert.equal(first, second, 'the link should keep working across repeat requests, not go stale');
});

test('EDITING GOES BACK TO PENDING — A SELF-EDIT MUST NOT SKIP RE-REVIEW', async () => {
  const job = await makeApprovedJobWithToken();
  const patch = await req('PATCH', `/deaf-community/jobs/manage/${job.manage_token}`, { body: { title: 'Updated Role Title' } });
  assert.equal(patch.status, 200);

  const check = await pool.query(`SELECT title, status FROM deaf_jobs WHERE id = $1`, [job.id]);
  assert.equal(check.rows[0].title, 'Updated Role Title');
  assert.equal(check.rows[0].status, 'pending', 'an edit must go back through moderation before it is live again');
});

test('ONLY THE ALLOW-LISTED FIELDS ARE REACHABLE — status, id AND THE TOKEN ITSELF CANNOT BE SET FROM THE BODY', async () => {
  const job = await makeApprovedJobWithToken();
  await req('PATCH', `/deaf-community/jobs/manage/${job.manage_token}`, {
    body: { title: 'Fine To Change', status: 'approved', manage_token: 'hijacked', id: 999999 },
  });
  const check = await pool.query(`SELECT id, status, manage_token FROM deaf_jobs WHERE id = $1`, [job.id]);
  assert.equal(check.rows[0].id, job.id, 'id must be unreachable from the body');
  assert.equal(check.rows[0].status, 'pending', 'status must only ever be set by the route logic, not the request body');
  assert.equal(check.rows[0].manage_token, job.manage_token, 'the token must not be replaceable from the body');
});

test('RENEWING EXTENDS THE 14-DAY WINDOW, BUT ONLY WHILE LIVE', async () => {
  const job = await makeApprovedJobWithToken();
  const before14 = await pool.query(`SELECT expires_at FROM deaf_jobs WHERE id = $1`, [job.id]);

  const renewed = await req('POST', `/deaf-community/jobs/manage/${job.manage_token}/renew`);
  assert.equal(renewed.status, 200);
  const after14 = await pool.query(`SELECT expires_at FROM deaf_jobs WHERE id = $1`, [job.id]);
  assert.ok(new Date(after14.rows[0].expires_at) > new Date(before14.rows[0].expires_at));

  // A pending row (created fresh, never approved) has no live period to
  // renew — a listing that was never live has nothing to extend.
  const pendingToken = 'pending-token-' + Date.now();
  await pool.query(
    `INSERT INTO deaf_jobs (business_name, title, description, apply_email, deaf_friendly_agreed, manage_token)
     VALUES ('Test Co', 'Pending Role', 'desc', 'p@test.com', true, $1)`,
    [pendingToken]
  );
  const cantRenew = await req('POST', `/deaf-community/jobs/manage/${pendingToken}/renew`);
  assert.equal(cantRenew.status, 400);
});

test('WITHDRAWING REMOVES IT FROM THE PUBLIC BOARD AND FROM THE ADMIN QUEUE', async () => {
  const job = await makeApprovedJobWithToken();
  const withdraw = await req('DELETE', `/deaf-community/jobs/manage/${job.manage_token}`);
  assert.equal(withdraw.status, 200);

  const publicList = await req('GET', '/deaf-community/jobs');
  assert.ok(!publicList.body.jobs.some((j) => j.id === job.id), 'a withdrawn job must not appear publicly');

  const pendingQueueRow = await pool.query(`SELECT status FROM deaf_jobs WHERE id = $1`, [job.id]);
  assert.equal(pendingQueueRow.rows[0].status, 'withdrawn');
});

test("WITHDRAWING TWICE ISN'T AN ERROR THE FIRST TIME AND IS REFUSED THE SECOND", async () => {
  const job = await makeApprovedJobWithToken();
  const first = await req('DELETE', `/deaf-community/jobs/manage/${job.manage_token}`);
  assert.equal(first.status, 200);
  const second = await req('DELETE', `/deaf-community/jobs/manage/${job.manage_token}`);
  assert.equal(second.status, 404, 'nothing left to withdraw the second time');
});

test('A WITHDRAWN LISTING GETS NO FURTHER MANAGE-LINK EMAILS', async () => {
  const job = await makeApprovedJobWithToken('gone@test.com');
  const withdrawn = await req('DELETE', `/deaf-community/jobs/manage/${job.manage_token}`);
  assert.equal(withdrawn.status, 200);
  await req('POST', '/deaf-community/jobs/manage-link', { body: { email: 'gone@test.com' } });
  assert.equal(outbox.length, 0, 'a withdrawn listing should not resurface a manage link');
});

test('A BOGUS TOKEN IS REFUSED ON EVERY MANAGE ROUTE, NOT JUST ONE', async () => {
  const bogus = 'a'.repeat(64);
  assert.equal((await req('GET', `/deaf-community/jobs/manage/${bogus}`)).status, 404);
  assert.equal((await req('PATCH', `/deaf-community/jobs/manage/${bogus}`, { body: { title: 'x' } })).status, 404);
  assert.equal((await req('POST', `/deaf-community/jobs/manage/${bogus}/renew`)).status, 400);
  assert.equal((await req('DELETE', `/deaf-community/jobs/manage/${bogus}`)).status, 404);
});

// -------------------------------------------------------------- passports

test('THE SAME BEHAVIOUR APPLIES TO PASSPORTS, NOT JUST JOBS', async () => {
  const created = await pool.query(
    `INSERT INTO deaf_passports (name, email, status) VALUES ('Test Person', 'passport@test.com', 'approved')
     RETURNING id, manage_token`
  );
  const passport = created.rows[0];

  const link = await req('POST', '/deaf-community/passports/manage-link', { body: { email: 'passport@test.com' } });
  assert.equal(link.status, 200);
  const token = outbox[outbox.length - 1].text.match(/token=([a-f0-9]+)/)[1];

  const managed = await req('GET', `/deaf-community/passports/manage/${token}`);
  assert.equal(managed.status, 200);
  assert.equal(managed.body.passport.email, 'passport@test.com');

  const edited = await req('PATCH', `/deaf-community/passports/manage/${token}`, { body: { availability: 'Weekends only' } });
  assert.equal(edited.status, 200);
  const afterEdit = await pool.query(`SELECT availability, status FROM deaf_passports WHERE id = $1`, [passport.id]);
  assert.equal(afterEdit.rows[0].availability, 'Weekends only');
  assert.equal(afterEdit.rows[0].status, 'pending');

  const withdrawn = await req('DELETE', `/deaf-community/passports/manage/${token}`);
  assert.equal(withdrawn.status, 200);
  const publicPassports = await req('GET', '/deaf-community/passports');
  assert.ok(!publicPassports.body.passports.some((p) => p.id === passport.id));
});

test('MIGRATION 170 SURVIVES BEING RE-RUN', async () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'db', 'migrations', '170_deaf_community_self_service.sql'), 'utf8');
  await assert.doesNotReject(() => pool.query(sql));
  await assert.doesNotReject(() => pool.query(sql));
});
