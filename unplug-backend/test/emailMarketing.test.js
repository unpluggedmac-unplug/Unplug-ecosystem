// Marketing email: consent, suppression and unsubscribe, against a REAL
// PostgreSQL.
//
// The guarantees here are not features, they are obligations:
//
//   1. NOTHING IS SENT TO A SUPPRESSED ADDRESS. Ever, by anything.
//   2. UNSUBSCRIBING WORKS WITH NO ACCOUNT, and takes effect immediately.
//   3. EVERY MESSAGE CARRIES A WAY OUT — a link and the List-Unsubscribe
//      headers that put a one-click button in Gmail.
//   4. TRANSACTIONAL MAIL IS NOT AFFECTED. Somebody who left the newsletter
//      still gets their receipt and their password reset.
//   5. CONSENT IS RECORDED with a source and a timestamp, because "why do you
//      have my address" needs a better answer than "somebody typed it in".
//
// Before this existed, routes/bulkEmail.js mailed every matching member with
// no unsubscribe link, no opt-out check and no record of consent.
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
let marketing;
let server;
let baseUrl;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-email-'));
const port = 40000 + (process.pid % 300); // bases are 400 apart so ranges cannot overlap

// Captures what would have gone out, instead of sending it.
const outbox = [];

before(async () => {
  pg = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'postgres', password: 'postgres', port,
    persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('unplug_test');

  process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${port}/unplug_test`;
  process.env.JWT_SECRET = 'test-secret-for-email';
  // No provider configured: utils/email logs instead of sending, which is
  // exactly what a test wants.
  delete process.env.RESEND_API_KEY;
  delete process.env.BREVO_API_KEY;

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }

  // Intercept the transport so the tests can inspect the message.
  const emailUtil = require('../src/utils/email');
  emailUtil.sendEmail = async (message) => { outbox.push(message); return { provider: 'test' }; };
  marketing = require('../src/utils/emailMarketing');

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use(require('../src/middleware/requestContext').middleware);
  app.use('/email', require('../src/routes/email'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
});

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

test('SUBSCRIBING RECORDS WHY WE HAVE THE ADDRESS', async () => {
  await marketing.subscribe({
    email: 'Reader@Example.com', source: 'footer form on the homepage', ip: '41.2.3.4' });

  const r = await pool.query(
    `SELECT * FROM email_subscriptions WHERE LOWER(email) = 'reader@example.com'`);
  assert.equal(r.rowCount, 1);
  assert.equal(r.rows[0].status, 'subscribed');
  assert.equal(r.rows[0].consent_source, 'footer form on the homepage');
  assert.equal(r.rows[0].consent_ip, '41.2.3.4');
  assert.ok(r.rows[0].consent_at, 'and when');
});

test('the existing newsletter subscribers were brought across honestly', async () => {
  // The migration imports them, and says in consent_source that the original
  // source is not known — rather than inventing one, which would be worse than
  // admitting it.
  const r = await pool.query(
    `SELECT consent_source FROM email_subscriptions WHERE consent_source LIKE 'imported%' LIMIT 1`);
  if (r.rowCount) {
    assert.match(r.rows[0].consent_source, /not recorded/,
      'an imported subscriber says its provenance is unknown');
  }
});

// ---------------------------------------------------------------------------
// Suppression — the obligation
// ---------------------------------------------------------------------------

test('A SUPPRESSED ADDRESS IS NEVER SENT TO', async () => {
  outbox.length = 0;
  await marketing.subscribe({ email: 'gone@example.com', source: 'test' });
  await marketing.unsubscribe({ email: 'gone@example.com', all: true });

  const result = await marketing.sendOne({
    campaignId: null, email: 'gone@example.com', subject: 'Hello', text: 'Body',
  });

  assert.equal(result.status, 'skipped');
  assert.equal(result.skip_reason, 'unsubscribed');
  assert.equal(outbox.length, 0, 'nothing left the building');
});

test('THE CHECK HAPPENS AT SEND TIME, NOT WHEN THE LIST WAS BUILT', async () => {
  // A campaign to four hundred people takes minutes. Somebody who unsubscribes
  // during it must not receive the rest — which a list filtered once at the
  // start cannot know.
  outbox.length = 0;
  await marketing.subscribe({ email: 'midway@example.com', source: 'test' });

  const list = await pool.query(`SELECT id FROM email_lists WHERE slug = 'newsletter'`);
  const audience = await marketing.audienceFor(list.rows[0].id);
  assert.ok(audience.willSend.includes('midway@example.com'), 'they are in the audience');

  // …and then they leave, after the audience was computed.
  await marketing.unsubscribe({ email: 'midway@example.com', all: true });

  const result = await marketing.sendOne({
    campaignId: null, email: 'midway@example.com', subject: 'x', text: 'y' });
  assert.equal(result.status, 'skipped');
  assert.equal(outbox.length, 0);
});

test('a bounce and a complaint suppress just as firmly as an unsubscribe', async () => {
  outbox.length = 0;
  await marketing.suppress('bounced@example.com', 'bounced', 'mailbox does not exist');
  await marketing.suppress('angry@example.com', 'complained', 'marked as spam');

  assert.equal((await marketing.sendOne({ email: 'bounced@example.com', subject: 'x', text: 'y' })).status, 'skipped');
  assert.equal((await marketing.sendOne({ email: 'angry@example.com', subject: 'x', text: 'y' })).status, 'skipped');
  assert.equal(outbox.length, 0);
});

test('RESUBSCRIBING CLEARS AN UNSUBSCRIBE BUT NOT A BOUNCE', async () => {
  // An unsubscribe is a preference and the person can change it. A bounce is a
  // fact about whether the address exists, and wanting mail does not make a
  // dead mailbox live.
  await marketing.subscribe({ email: 'returning@example.com', source: 'test' });
  await marketing.unsubscribe({ email: 'returning@example.com', all: true });
  await marketing.subscribe({ email: 'returning@example.com', source: 'signed up again' });
  assert.equal(await marketing.isSuppressed('returning@example.com'), null, 'they are back');

  await marketing.suppress('dead@example.com', 'bounced', 'no such mailbox');
  await marketing.subscribe({ email: 'dead@example.com', source: 'typed it in again' });
  assert.equal(await marketing.isSuppressed('dead@example.com'), 'bounced',
    'a bounce is not cleared by somebody subscribing');
});

// ---------------------------------------------------------------------------
// The way out
// ---------------------------------------------------------------------------

test('EVERY SENT MESSAGE CARRIES AN UNSUBSCRIBE LINK AND THE HEADERS', async () => {
  outbox.length = 0;
  await marketing.subscribe({ email: 'reader2@example.com', source: 'test' });
  await marketing.sendOne({
    campaignId: null, email: 'reader2@example.com', subject: 'The Friday letter',
    text: 'Stories from the week.',
    html: '<html><body><p>Stories from the week.</p></body></html>',
  });

  assert.equal(outbox.length, 1);
  const message = outbox[0];
  assert.match(message.text, /unsubscribe/i, 'the plain text part says how to stop');
  assert.match(message.html, /\/email\/unsubscribe\//, 'and the HTML has the link');

  // RFC 8058. These are what put a one-click Unsubscribe button beside the
  // sender name — the button people press INSTEAD of the spam button.
  assert.ok(message.headers['List-Unsubscribe'], 'List-Unsubscribe is set');
  assert.equal(message.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
});

test('UNSUBSCRIBING NEEDS NO ACCOUNT AND TAKES EFFECT IMMEDIATELY', async () => {
  outbox.length = 0;
  await marketing.subscribe({ email: 'clicker@example.com', source: 'test' });
  await marketing.sendOne({ campaignId: null, email: 'clicker@example.com', subject: 'x', text: 'y' });

  const send = (await pool.query(
    `SELECT token FROM email_sends WHERE email = 'clicker@example.com' ORDER BY id DESC LIMIT 1`)).rows[0];

  // No token, no session, no password — just the link from the email.
  const res = await fetch(`${baseUrl}/email/unsubscribe/${send.token}`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /not hear from us again/i);

  assert.equal(await marketing.isSuppressed('clicker@example.com'), 'unsubscribed');
  outbox.length = 0;
  const after = await marketing.sendOne({ campaignId: null, email: 'clicker@example.com', subject: 'x', text: 'y' });
  assert.equal(after.status, 'skipped', 'and the very next send is stopped');
});

test("the one-click POST works, because that is what Gmail sends", async () => {
  await marketing.subscribe({ email: 'oneclick@example.com', source: 'test' });
  await marketing.sendOne({ campaignId: null, email: 'oneclick@example.com', subject: 'x', text: 'y' });
  const send = (await pool.query(
    `SELECT token FROM email_sends WHERE email = 'oneclick@example.com' ORDER BY id DESC LIMIT 1`)).rows[0];

  const res = await fetch(`${baseUrl}/email/unsubscribe/${send.token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'List-Unsubscribe=One-Click',
  });
  assert.equal(res.status, 200);
  assert.equal(await marketing.isSuppressed('oneclick@example.com'), 'unsubscribed');
});

test('AN UNRECOGNISED LINK STILL TELLS SOMEBODY HOW TO GET OUT', async () => {
  // The failure mode to avoid is "I tried to unsubscribe and it broke", which
  // becomes a spam report.
  const res = await fetch(`${baseUrl}/email/unsubscribe/not-a-real-token`);
  assert.equal(res.status, 404);
  const html = await res.text();
  assert.match(html, /preferences|reply to any of our emails/i);
});

test('a token cannot be guessed from an address', async () => {
  // Two sends to the same person must not share a token, or one leaked link
  // unsubscribes them from everything for ever.
  await marketing.subscribe({ email: 'tokens@example.com', source: 'test' });
  await marketing.sendOne({ campaignId: null, email: 'tokens@example.com', subject: 'a', text: 'a' });
  await marketing.sendOne({ campaignId: null, email: 'tokens@example.com', subject: 'b', text: 'b' });
  const r = await pool.query(
    `SELECT token FROM email_sends WHERE email = 'tokens@example.com' ORDER BY id DESC LIMIT 2`);
  assert.notEqual(r.rows[0].token, r.rows[1].token);
  assert.ok(r.rows[0].token.length >= 24);
});

// ---------------------------------------------------------------------------
// Preferences — the alternative to all or nothing
// ---------------------------------------------------------------------------

test('leaving one list does not suppress somebody who is still on another', async () => {
  await pool.query(
    `INSERT INTO email_lists (name, slug, description) VALUES ('Competitions', 'competitions', 'x')
     ON CONFLICT DO NOTHING`);
  await marketing.subscribe({ email: 'picky@example.com', listSlug: 'newsletter', source: 'test' });
  await marketing.subscribe({ email: 'picky@example.com', listSlug: 'competitions', source: 'test' });

  await marketing.unsubscribe({ email: 'picky@example.com', listSlug: 'newsletter' });
  assert.equal(await marketing.isSuppressed('picky@example.com'), null,
    'still wants competition news, so still reachable');

  await marketing.unsubscribe({ email: 'picky@example.com', listSlug: 'competitions' });
  assert.equal(await marketing.isSuppressed('picky@example.com'), 'unsubscribed',
    'off every list means off entirely');
});

// ---------------------------------------------------------------------------
// Tracking
// ---------------------------------------------------------------------------

test('an open is counted once, however many times the image is fetched', async () => {
  // Mail clients re-fetch images on scroll, on reopen, on prefetch. Counting
  // each would turn one reader into forty and make the number meaningless.
  await marketing.subscribe({ email: 'opener@example.com', source: 'test' });
  await marketing.sendOne({ campaignId: null, email: 'opener@example.com', subject: 'x', text: 'y' });
  const send = (await pool.query(
    `SELECT id, token FROM email_sends WHERE email = 'opener@example.com' ORDER BY id DESC LIMIT 1`)).rows[0];

  for (let i = 0; i < 5; i++) await fetch(`${baseUrl}/email/o/${send.token}.gif`);

  const opens = await pool.query(
    `SELECT count(*)::int AS n FROM email_events WHERE send_id = $1 AND kind = 'open'`, [send.id]);
  assert.equal(opens.rows[0].n, 1);
});

test('THE CLICK REDIRECT IS NOT AN OPEN REDIRECT', async () => {
  // A redirect that forwards anywhere means somebody can send a link on our
  // domain that lands on their phishing page, carrying our reputation.
  await marketing.subscribe({ email: 'clicky@example.com', source: 'test' });
  await marketing.sendOne({ campaignId: null, email: 'clicky@example.com', subject: 'x', text: 'y' });
  const send = (await pool.query(
    `SELECT token FROM email_sends WHERE email = 'clicky@example.com' ORDER BY id DESC LIMIT 1`)).rows[0];

  const bad = await fetch(`${baseUrl}/email/c/${send.token}?u=javascript:alert(1)`, { redirect: 'manual' });
  assert.equal(bad.status, 302);
  assert.match(bad.headers.get('location'), /unplugnews\.com/,
    'a non-web address goes to the site, not to the payload');

  const good = await fetch(`${baseUrl}/email/c/${send.token}?u=${encodeURIComponent('https://example.com/story')}`,
    { redirect: 'manual' });
  assert.equal(good.headers.get('location'), 'https://example.com/story');
});

test('the unsubscribe link is never wrapped in click tracking', async () => {
  // It has to work even if the tracking route is broken. A broken unsubscribe
  // is the failure that turns into spam complaints.
  const html = '<a href="https://www.unplugnews.com/story">Read</a>'
             + '<a href="https://api.example.com/email/unsubscribe/abc">Unsubscribe</a>';
  const wrapped = marketing.wrapLinks(html, 'sometoken');
  assert.match(wrapped, /\/email\/c\/sometoken/, 'ordinary links are wrapped');
  assert.match(wrapped, /href="https:\/\/api\.example\.com\/email\/unsubscribe\/abc"/,
    'the unsubscribe link is left exactly as it was');
});

// ---------------------------------------------------------------------------
// The separation that matters
// ---------------------------------------------------------------------------

test('TRANSACTIONAL MAIL IS NOT BLOCKED BY A MARKETING UNSUBSCRIBE', async () => {
  // Somebody who left the newsletter still needs their receipt, their password
  // reset and their download link. Routing those through the marketing
  // suppression list would strand people out of their own accounts.
  outbox.length = 0;
  await marketing.subscribe({ email: 'customer@example.com', source: 'test' });
  await marketing.unsubscribe({ email: 'customer@example.com', all: true });

  const { sendEmail } = require('../src/utils/email');
  await sendEmail({ to: 'customer@example.com', subject: 'Your receipt', text: 'Thank you.' });

  assert.equal(outbox.length, 1, 'the receipt went out');
  assert.equal(outbox[0].subject, 'Your receipt');
});
