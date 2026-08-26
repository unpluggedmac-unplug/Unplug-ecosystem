// Bounce and complaint webhooks, against a REAL PostgreSQL and a real HTTP server.
//
// THIS ENDPOINT SUPPRESSES EMAIL ADDRESSES, which makes it the most dangerous
// unauthenticated route in the codebase. What these tests are protecting:
//
//   1. AN UNSIGNED REQUEST CHANGES NOTHING. Without this, anybody who found
//      the URL could POST 'bounced' for every subscriber in turn and silently
//      destroy the mailing list — and it would look like a deliverability
//      problem for weeks rather than an attack.
//   2. A FORGED OR REPLAYED SIGNATURE CHANGES NOTHING.
//   3. A SOFT BOUNCE DOES NOT SUPPRESS ANYBODY. A full mailbox on a Tuesday
//      must not remove a real reader for good.
//   4. A COMPLAINT ALWAYS SUPPRESSES, with no second chance. Somebody pressed
//      the spam button.
//   5. RETRIES DO NOT INFLATE THE NUMBERS. Svix redelivers until it gets a
//      2xx, so the same event arrives several times as a matter of course.
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
let svix;
let marketing;
let server;
let baseUrl;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-hooks-'));
const port = 40800 + (process.pid % 300); // bases are 400 apart so ranges cannot overlap

const SECRET = 'whsec_' + Buffer.from('a-test-signing-secret-32-bytes!!').toString('base64');

before(async () => {
  pg = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'postgres', password: 'postgres', port,
    persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('unplug_test');

  process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${port}/unplug_test`;
  process.env.JWT_SECRET = 'test-secret-for-hooks';
  process.env.RESEND_WEBHOOK_SECRET = SECRET;
  delete process.env.RESEND_API_KEY;
  delete process.env.BREVO_API_KEY;

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations'))
    .filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }

  svix = require('../src/utils/svixSignature');
  marketing = require('../src/utils/emailMarketing');

  const express = require('express');
  const app = express();
  // Mounted the same way app.js mounts it: no global JSON parser in front, so
  // the router's own express.raw() sees the untouched bytes.
  app.use('/email/webhooks', require('../src/routes/emailWebhooks'));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
});

let counter = 0;

// Posts a payload, signed unless told otherwise.
async function hook(payload, { secret = SECRET, timestamp, headers } = {}) {
  const body = JSON.stringify(payload);
  const id = 'msg_' + (counter += 1);
  const ts = timestamp || Math.floor(Date.now() / 1000);
  const signed = secret ? svix.sign({ body, id, timestamp: ts, secret }) : {};
  const res = await fetch(baseUrl + '/email/webhooks/resend', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...signed, ...(headers || {}) },
    body,
  });
  return { status: res.status, body: await res.json().catch(() => null), signed, raw: body };
}

async function seedSend(email, providerId) {
  const r = await pool.query(
    `INSERT INTO email_sends (email, token, status, provider_id, sent_at)
     VALUES ($1, $2, 'sent', $3, now()) RETURNING *`,
    [email, 'tok-' + (counter += 1), providerId]);
  return r.rows[0];
}

const suppressionOf = async (email) => {
  const r = await pool.query('SELECT * FROM email_suppressions WHERE email = $1', [email]);
  return r.rowCount ? r.rows[0] : null;
};

// ---------------------------------------------------------------------------
// The signature is the whole security model
// ---------------------------------------------------------------------------

test('AN UNSIGNED REQUEST IS REFUSED AND CHANGES NOTHING', async () => {
  await seedSend('victim@test.com', 'prov-unsigned');
  const res = await hook(
    { type: 'email.bounced', data: { email_id: 'prov-unsigned', to: ['victim@test.com'],
      bounce: { type: 'Permanent' } } },
    { secret: null });

  assert.equal(res.status, 401);
  assert.equal(await suppressionOf('victim@test.com'), null,
    'nobody is suppressed by a request that was not signed');
});

test('A FORGED SIGNATURE IS REFUSED', async () => {
  await seedSend('forged@test.com', 'prov-forged');
  const wrongSecret = 'whsec_' + Buffer.from('the-wrong-secret-entirely-32b!!!').toString('base64');
  const res = await hook(
    { type: 'email.bounced', data: { email_id: 'prov-forged', to: ['forged@test.com'],
      bounce: { type: 'Permanent' } } },
    { secret: wrongSecret });

  assert.equal(res.status, 401);
  assert.equal(await suppressionOf('forged@test.com'), null);
});

test('A REPLAYED REQUEST FROM AN HOUR AGO IS REFUSED', async () => {
  // Signatures do not expire on their own. Without a timestamp check a
  // captured request could be replayed for ever — which is a way to keep an
  // address suppressed after somebody has legitimately been let back on.
  await seedSend('replay@test.com', 'prov-replay');
  const res = await hook(
    { type: 'email.bounced', data: { email_id: 'prov-replay', to: ['replay@test.com'],
      bounce: { type: 'Permanent' } } },
    { timestamp: Math.floor(Date.now() / 1000) - 3600 });

  assert.equal(res.status, 401);
  assert.equal(await suppressionOf('replay@test.com'), null);
});

test('THE SIGNATURE IS OVER THE EXACT BYTES, so a re-serialised body fails', async () => {
  // This is the failure that looks like a wrong secret and is not. If the body
  // is parsed and stringified again anywhere before verification, key order
  // and spacing change and the signature no longer matches.
  const body = '{"type":"email.delivered","data":{"email_id":"x"}}';
  // The same object, with the keys in the order JSON.parse/stringify would
  // leave them after a round trip through a body parser.
  const reordered = '{"data":{"email_id":"x"},"type":"email.delivered"}';
  const ts = Math.floor(Date.now() / 1000);
  const signed = svix.sign({ body, id: 'msg_bytes', timestamp: ts, secret: SECRET });

  const good = svix.verify({ body, headers: signed, secret: SECRET });
  const bad = svix.verify({ body: reordered, headers: signed, secret: SECRET });
  assert.equal(good.ok, true);
  assert.equal(bad.ok, false, 'the same content in a different order does not verify');
});

test('a rotated secret keeps working while both signatures are sent', async () => {
  // Svix sends the old and the new signature together during a rotation.
  // Rejecting because the first listed is the old one would drop every bounce
  // for a day.
  const body = '{"type":"email.delivered"}';
  const ts = Math.floor(Date.now() / 1000);
  const oldSig = svix.sign({ body, id: 'm1', timestamp: ts,
    secret: 'whsec_' + Buffer.from('an-older-secret-of-32-bytes!!!!!').toString('base64') });
  const newSig = svix.sign({ body, id: 'm1', timestamp: ts, secret: SECRET });

  const combined = { ...newSig, 'svix-signature': oldSig['svix-signature'] + ' ' + newSig['svix-signature'] };
  assert.equal(svix.verify({ body, headers: combined, secret: SECRET }).ok, true);
});

// ---------------------------------------------------------------------------
// Bounces
// ---------------------------------------------------------------------------

test('A HARD BOUNCE SUPPRESSES THE ADDRESS AND STOPS ITS SEQUENCES', async () => {
  const send = await seedSend('dead@test.com', 'prov-hard');

  // Somebody part-way through a welcome sequence.
  const a = await pool.query(
    `INSERT INTO email_automations (name, trigger, active) VALUES ('W', 'manual', true) RETURNING id`);
  await pool.query(
    `INSERT INTO email_automation_steps (automation_id, position, delay_hours, subject)
     VALUES ($1, 1, 0, 'S1')`, [a.rows[0].id]);
  await pool.query(
    `INSERT INTO email_automation_enrolments (automation_id, email) VALUES ($1, 'dead@test.com')`,
    [a.rows[0].id]);

  const res = await hook({
    type: 'email.bounced',
    data: { email_id: 'prov-hard', to: ['dead@test.com'],
      bounce: { type: 'Permanent', subType: 'NoEmail', message: 'no such mailbox' } },
  });

  assert.equal(res.status, 200);
  const suppression = await suppressionOf('dead@test.com');
  assert.ok(suppression, 'the address is suppressed');
  assert.equal(suppression.reason, 'bounced');

  const enrolment = await pool.query(
    `SELECT status, stopped_reason FROM email_automation_enrolments WHERE email = 'dead@test.com'`);
  // Five more steps to an address that does not exist is five more failures
  // against the sending reputation for no possible benefit.
  assert.equal(enrolment.rows[0].status, 'cancelled');
  assert.equal(enrolment.rows[0].stopped_reason, 'bounced');

  const events = await pool.query(
    `SELECT kind FROM email_events WHERE send_id = $1`, [send.id]);
  assert.deepEqual(events.rows.map((r) => r.kind), ['bounce']);
});

test('A SOFT BOUNCE DOES NOT SUPPRESS ANYBODY', async () => {
  // A full mailbox, a server having a bad afternoon, a greylisting delay.
  // Suppressing on the first one permanently removes somebody whose inbox
  // happened to be full on a Tuesday.
  const send = await seedSend('busy@test.com', 'prov-soft');
  const res = await hook({
    type: 'email.bounced',
    data: { email_id: 'prov-soft', to: ['busy@test.com'],
      bounce: { type: 'Transient', subType: 'MailboxFull' } },
  });

  assert.equal(res.status, 200);
  assert.equal(await suppressionOf('busy@test.com'), null, 'still mailable');
  // But it is recorded, so a pattern of them is visible.
  const events = await pool.query('SELECT kind FROM email_events WHERE send_id = $1', [send.id]);
  assert.deepEqual(events.rows.map((r) => r.kind), ['bounce']);
});

test('A BOUNCE WITH NO TYPE AT ALL IS TREATED AS SOFT', async () => {
  // Older payloads carry no bounce.type. Being wrong in this direction costs
  // one wasted send; being wrong in the other loses a reader for good.
  await seedSend('untyped@test.com', 'prov-untyped');
  const res = await hook({
    type: 'email.bounced',
    data: { email_id: 'prov-untyped', to: ['untyped@test.com'] },
  });
  assert.equal(res.status, 200);
  assert.equal(await suppressionOf('untyped@test.com'), null);
});

// ---------------------------------------------------------------------------
// Complaints
// ---------------------------------------------------------------------------

test('A COMPLAINT ALWAYS SUPPRESSES, with no soft/hard distinction', async () => {
  await seedSend('angry@test.com', 'prov-complaint');
  const res = await hook({
    type: 'email.complained',
    data: { email_id: 'prov-complaint', to: ['angry@test.com'] },
  });

  assert.equal(res.status, 200);
  const suppression = await suppressionOf('angry@test.com');
  assert.ok(suppression);
  assert.equal(suppression.reason, 'complained');
});

test('SUBSCRIBING AGAIN DOES NOT CLEAR A COMPLAINT OR A BOUNCE', async () => {
  // Re-subscribing clears a previous *unsubscribe*, because the person has
  // just asked. It must not clear a bounce or a complaint: those are facts
  // about whether mail can be delivered at all, not about what somebody wants.
  await pool.query(
    `INSERT INTO email_lists (name, slug) VALUES ('Hooks', 'hooks-list') ON CONFLICT DO NOTHING`);
  await marketing.subscribe({ email: 'angry@test.com', listSlug: 'hooks-list', source: 'test' });

  const suppression = await suppressionOf('angry@test.com');
  assert.ok(suppression, 'still suppressed');
  assert.equal(suppression.reason, 'complained');
});

// ---------------------------------------------------------------------------
// Retries
// ---------------------------------------------------------------------------

test('THE SAME EVENT DELIVERED FIVE TIMES IS COUNTED ONCE', async () => {
  const send = await seedSend('retry@test.com', 'prov-retry');
  for (let i = 0; i < 5; i += 1) {
    const res = await hook({
      type: 'email.delivered', data: { email_id: 'prov-retry', to: ['retry@test.com'] },
    });
    assert.equal(res.status, 200);
  }
  const events = await pool.query(
    `SELECT count(*)::int AS n FROM email_events WHERE send_id = $1 AND kind = 'delivered'`,
    [send.id]);
  assert.equal(events.rows[0].n, 1);
});

test('opens and clicks from the provider are ignored, because we measure our own', async () => {
  // Recording both would double every number in the reporting.
  const send = await seedSend('double@test.com', 'prov-double');
  await hook({ type: 'email.opened', data: { email_id: 'prov-double', to: ['double@test.com'] } });
  await hook({ type: 'email.clicked', data: { email_id: 'prov-double', to: ['double@test.com'] } });
  const events = await pool.query('SELECT count(*)::int AS n FROM email_events WHERE send_id = $1', [send.id]);
  assert.equal(events.rows[0].n, 0);
});

test('an event for a message we have no record of is accepted, not retried for ever', async () => {
  // A 500 would have Svix redeliver it indefinitely. There is nothing to
  // attribute it to and nothing that will change that.
  const res = await hook({
    type: 'email.delivered', data: { email_id: 'never-heard-of-it', to: ['stranger@test.com'] },
  });
  assert.equal(res.status, 200);
});

test('a hard bounce for an unknown message still suppresses the address', async () => {
  // The send record is gone or was never ours, but the address is still dead
  // and must not be mailed again.
  const res = await hook({
    type: 'email.bounced',
    data: { email_id: 'unknown-msg', to: ['ghost@test.com'], bounce: { type: 'Permanent' } },
  });
  assert.equal(res.status, 200);
  const suppression = await suppressionOf('ghost@test.com');
  assert.ok(suppression);
  assert.equal(suppression.reason, 'bounced');
});
