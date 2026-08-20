// STARTING A NURTURE SEQUENCE — and, more importantly, NOT starting one.
//
// Two five-email sequences live in Resend, triggered by named events this
// backend fires. The failure that matters is not a missing email; it is an
// UNWANTED one:
//
//   1. Somebody asking a general question through the contact form must never
//      be enrolled in a five-email advertising sequence. The kind of enquiry
//      is a real column, deliberately NOT inferred from the words in a
//      subject line.
//   2. Nominating a friend WITHOUT giving an address must not fire anything —
//      there is nobody to email, and tipping us off is not consent.
//   3. A marketing call must never fail the thing the visitor actually did.
//      A signup that 500s because a mailing list was unreachable is a real
//      loss; a missed sequence is not.
//
// The Resend transport is stubbed by replacing global.fetch, so these run with
// no API key and send nothing anywhere.
//
// Run with:  npm test   (from unplug-backend/)

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const EmbeddedPostgres = require('embedded-postgres').default;

let pg;
let pool;
let server;
let baseUrl;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-mkt-'));
const port = 30800 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

// Everything the stubbed transport was asked to send.
let calls = [];
let realFetch;

async function req(method, urlPath, body) {
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
  process.env.JWT_SECRET = 'test-secret-for-marketing';
  process.env.UNPLUG_DISABLE_RATE_LIMITS = '1';
  // Set BEFORE the module is required — it reads the key once at load.
  process.env.RESEND_API_KEY = 'test-key-not-real';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }

  // Intercept only api.resend.com; the test's own HTTP calls must still work.
  realFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (String(url).startsWith('https://api.resend.com')) {
      calls.push({ url: String(url), body: JSON.parse(options.body || '{}') });
      return { ok: true, status: 200, json: async () => ({ id: 'stub' }), text: async () => '' };
    }
    return realFetch(url, options);
  };

  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/inquiries', require('../src/routes/inquiries'));
  app.use('/newsletter', require('../src/routes/newsletter'));
  app.use('/shoutouts', require('../src/routes/shoutouts'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (realFetch) global.fetch = realFetch;
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  // Windows can still hold a handle on the data directory when Postgres
  // exits, and embedded-postgres removes that directory as part of
  // stopping. The server is already down by then, so an EBUSY here is
  // the OS being slow to let go, not a failure worth failing the file
  // for — and a teardown that goes red teaches everyone to ignore red.
  try { if (pg) await pg.stop(); } catch (e) { /* see above */ }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* Windows holds the dir briefly */ }
});

beforeEach(() => { calls = []; });

// The event fires after the response, so give the fire-and-forget call a beat.
const settle = () => new Promise((r) => setTimeout(r, 250));
const events = () => calls.filter((c) => c.url.endsWith('/events'));

// ---------------------------------------------------------------------------
// Firing
// ---------------------------------------------------------------------------

test('a newsletter signup starts the reader sequence', async () => {
  const res = await req('POST', '/newsletter/subscribe', { email: 'reader@example.com' });
  assert.equal(res.status, 201);
  await settle();

  const fired = events();
  assert.equal(fired.length, 1);
  assert.equal(fired[0].body.event, 'unplug.nominator.joined');
  assert.equal(fired[0].body.email, 'reader@example.com');
});

test('a nomination carries the NOMINEE NAME, which is what makes email 1 personal', async () => {
  const res = await req('POST', '/shoutouts/nominate', {
    nomineeName: 'Naledi Mokoena', message: 'She feeds the whole street.', email: 'friend@example.com',
  });
  assert.equal(res.status, 201);
  await settle();

  const fired = events();
  assert.equal(fired.length, 1);
  assert.equal(fired[0].body.event, 'unplug.nominator.joined');
  assert.equal(fired[0].body.payload.NOMINEE_NAME, 'Naledi Mokoena',
    'without this the thank-you email cannot say who it was about');
});

test('NOMINATING WITHOUT AN ADDRESS FIRES NOTHING', async () => {
  // There is nobody to email, and tipping us off about a friend is not
  // consent to be added to a mailing list.
  const res = await req('POST', '/shoutouts/nominate', { nomineeName: 'Anonymous Tip' });
  assert.equal(res.status, 201, 'the nomination itself still works');
  await settle();
  assert.equal(events().length, 0);
});

test('an ADVERTISING enquiry starts the advertiser sequence', async () => {
  const res = await req('POST', '/inquiries', {
    name: 'Thabo Mokoena', email: 'thabo@business.co.za',
    subject: 'Bo-Kaap Bakery', message: 'We would like a banner.',
    enquiryType: 'advertising',
  });
  assert.equal(res.status, 201);
  await settle();

  const fired = events();
  assert.equal(fired.length, 1);
  assert.equal(fired[0].body.event, 'unplug.advertiser.enquired');
  assert.equal(fired[0].body.payload.businessName, 'Bo-Kaap Bakery');

  const row = await pool.query(`SELECT enquiry_type FROM inquiries WHERE email = 'thabo@business.co.za'`);
  assert.equal(row.rows[0].enquiry_type, 'advertising');
});

// ---------------------------------------------------------------------------
// NOT firing — the failures that would actually hurt
// ---------------------------------------------------------------------------

test('A GENERAL ENQUIRY MUST NOT START THE ADVERTISER SEQUENCE', async () => {
  // Somebody asking where to find an article receiving five sales emails is
  // the worst outcome this whole feature can produce.
  const res = await req('POST', '/inquiries', {
    name: 'Curious Reader', email: 'reader2@example.com',
    subject: 'Question about an article', message: 'Where can I find the piece about the bakery?',
  });
  assert.equal(res.status, 201);
  await settle();
  assert.equal(events().length, 0, 'NO SALES SEQUENCE FOR SOMEBODY WHO ASKED A QUESTION');

  const row = await pool.query(`SELECT enquiry_type FROM inquiries WHERE email = 'reader2@example.com'`);
  assert.equal(row.rows[0].enquiry_type, 'general');
});

test('the word "advertising" in a message does not enrol anybody', async () => {
  // The kind of enquiry is a real column precisely so it is never guessed
  // from what somebody happened to type.
  await req('POST', '/inquiries', {
    name: 'Reader Three', email: 'reader3@example.com',
    subject: 'Your advertising is too loud',
    message: 'I find the advertising on the site distracting.',
  });
  await settle();
  assert.equal(events().length, 0);
});

test('an unrecognised enquiry type falls back to general', async () => {
  await req('POST', '/inquiries', {
    name: 'Odd One', email: 'odd@example.com', message: 'Hello',
    enquiryType: 'sponsorship-deluxe',
  });
  await settle();
  assert.equal(events().length, 0);
  const row = await pool.query(`SELECT enquiry_type FROM inquiries WHERE email = 'odd@example.com'`);
  assert.equal(row.rows[0].enquiry_type, 'general');
});

// ---------------------------------------------------------------------------
// It must never break the thing the visitor actually did
// ---------------------------------------------------------------------------

test('A FAILING MARKETING CALL DOES NOT FAIL THE SIGNUP', async () => {
  global.fetch = async (url, options) => {
    if (String(url).startsWith('https://api.resend.com')) throw new Error('Resend is down');
    return realFetch(url, options);
  };
  try {
    const res = await req('POST', '/newsletter/subscribe', { email: 'resilient@example.com' });
    assert.equal(res.status, 201, 'the subscription still succeeds');
    await settle();
    const row = await pool.query(`SELECT 1 FROM newsletter_subscribers WHERE email = 'resilient@example.com'`);
    assert.equal(row.rows.length, 1, 'AND IS ACTUALLY SAVED');
  } finally {
    global.fetch = async (url, options) => {
      if (String(url).startsWith('https://api.resend.com')) {
        calls.push({ url: String(url), body: JSON.parse(options.body || '{}') });
        return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
      }
      return realFetch(url, options);
    };
  }
});

test('a rejected enquiry never reaches the mailing list', async () => {
  const res = await req('POST', '/inquiries', { name: '', email: '', message: '' });
  assert.equal(res.status, 400);
  await settle();
  assert.equal(events().length, 0);
});

test('re-running every migration is idempotent', async () => {
  const before = await pool.query('SELECT COUNT(*)::int AS n FROM inquiries');
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }
  const after = await pool.query('SELECT COUNT(*)::int AS n FROM inquiries');
  assert.equal(after.rows[0].n, before.rows[0].n);
  // And the default must hold for rows written before the column existed.
  const bad = await pool.query(`SELECT COUNT(*)::int AS n FROM inquiries WHERE enquiry_type IS NULL`);
  assert.equal(bad.rows[0].n, 0);
});

// ---------------------------------------------------------------------------
// Reporting which state the automation path is in
// ---------------------------------------------------------------------------

test('THE THREE FAILURE STATES ARE REPORTED APART', () => {
  // From the outside all three look like "nobody has signed up yet". The whole
  // point of this is that an admin can tell them apart.
  const keyBefore = process.env.RESEND_API_KEY;
  const audBefore = process.env.RESEND_AUDIENCE_ID;
  const load = () => {
    delete require.cache[require.resolve('../src/utils/marketingEvents')];
    return require('../src/utils/marketingEvents').marketingStatus();
  };

  try {
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_AUDIENCE_ID;
    const off = load();
    assert.equal(off.state, 'off');
    assert.equal(off.hasKey, false);
    assert.match(off.message, /no automation events are being sent/i);

    // The dangerous one: switched on in Resend, events arriving, nobody emailed.
    process.env.RESEND_API_KEY = 'test-key';
    delete process.env.RESEND_AUDIENCE_ID;
    const broken = load();
    assert.equal(broken.state, 'broken');
    assert.equal(broken.hasKey, true);
    assert.equal(broken.hasAudience, false);
    assert.match(broken.message, /RESEND_AUDIENCE_ID/,
      'the message must name the exact variable to set');

    process.env.RESEND_AUDIENCE_ID = 'aud_123';
    const ok = load();
    assert.equal(ok.state, 'ok');
    assert.match(ok.message, /Resend side/i,
      'when the path is healthy it should point at where the fault must be instead');
  } finally {
    if (keyBefore === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = keyBefore;
    if (audBefore === undefined) delete process.env.RESEND_AUDIENCE_ID;
    else process.env.RESEND_AUDIENCE_ID = audBefore;
    delete require.cache[require.resolve('../src/utils/marketingEvents')];
  }
});

test('the status names the exact trigger strings Resend has to match', () => {
  // A trigger that almost matches fires never, and comparing by eye against
  // a screenshot is how "almost" happens.
  const { marketingStatus, EVENTS } = require('../src/utils/marketingEvents');
  const status = marketingStatus();
  assert.deepEqual(status.events.sort(), Object.values(EVENTS).sort());
  assert.ok(status.events.includes('unplug.nominator.joined'));
  assert.ok(status.events.includes('unplug.advertiser.enquired'));
});
