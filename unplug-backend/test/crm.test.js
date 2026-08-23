// The CRM, against a REAL PostgreSQL.
//
// What this is protecting, in order of how badly it would hurt:
//
//   1. ONE PERSON IS ONE CONTACT. Somebody who enquires in March, buys in June
//      and asks a question in September must be one record. Three records is
//      three strangers, and the person answering in September cannot see that
//      this is a customer.
//   2. ATTRIBUTION IS NOT INVENTED. The source table is consent-gated, so for
//      a visitor who declined there is genuinely no source. Recording them as
//      "Direct" would inflate direct traffic with people who came from
//      Instagram.
//   3. THE PIPELINE IS NOT FULL OF DUPLICATES. A second enquiry about the same
//      thing is a signal, not a second opportunity.
//   4. THE NUMBERS DO NOT LIE. A close rate of 0% on a pipeline where nothing
//      has closed yet is a statement about performance that is not true.
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
let crm;
let server;
let baseUrl;
let jwt;
let adminToken;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-crm-'));
const port = 39600 + (process.pid % 300); // bases are 400 apart so ranges cannot overlap

async function api(method, urlPath, body, token = adminToken) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
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
  process.env.JWT_SECRET = 'test-secret-for-crm';
  process.env.UNPLUG_DISABLE_RATE_LIMITS = '1';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }
  crm = require('../src/utils/crmCapture');

  jwt = require('jsonwebtoken');
  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/crm', require('../src/routes/crm'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await pool.query(`INSERT INTO users (id, email, full_name, password_hash, role)
                    VALUES (990001, 'crmadmin@test.com', 'Cee Arm', 'x', 'admin'),
                           (990002, 'crmmember@test.com', 'Mem Ber', 'x', 'member')`);
  adminToken = jwt.sign({ id: 990001, email: 'crmadmin@test.com', role: 'admin' }, process.env.JWT_SECRET);
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
});

// ---------------------------------------------------------------------------
// One person, one contact
// ---------------------------------------------------------------------------

test('THREE SUBMISSIONS FROM ONE PERSON ARE ONE CONTACT', async () => {
  const email = 'thandi@example.com';
  await crm.captureSubmission({ email, fullName: 'Thandi Nkosi', formName: 'Contact form', message: 'First' });
  await crm.captureSubmission({ email, formName: 'Newsletter', message: 'Second' });
  await crm.captureSubmission({ email, phone: '0821234567', formName: 'Contact form', message: 'Third' });

  const r = await pool.query('SELECT * FROM crm_contacts WHERE email = $1', [email]);
  assert.equal(r.rowCount, 1, 'one record, not three');
  // And the details accumulate rather than overwriting each other with blanks.
  assert.equal(r.rows[0].full_name, 'Thandi Nkosi', 'the name given the first time survives');
  assert.equal(r.rows[0].phone, '0821234567', 'and the phone number given later is added');

  const timeline = await pool.query(
    'SELECT * FROM crm_activities WHERE contact_id = $1', [r.rows[0].id]);
  assert.equal(timeline.rowCount, 3, 'all three appear on the timeline');
});

test('the email is matched however it was capitalised', async () => {
  await crm.captureSubmission({ email: 'Mixed@Example.COM', formName: 'a' });
  await crm.captureSubmission({ email: 'mixed@example.com', formName: 'b' });
  const r = await pool.query(`SELECT count(*)::int AS n FROM crm_contacts WHERE LOWER(email) = 'mixed@example.com'`);
  assert.equal(r.rows[0].n, 1);
});

test('a submission with no usable email creates nothing', async () => {
  const before = (await pool.query('SELECT count(*)::int AS n FROM crm_contacts')).rows[0].n;
  await crm.captureSubmission({ email: 'not-an-email', formName: 'x' });
  await crm.captureSubmission({ email: '', formName: 'x' });
  const after = (await pool.query('SELECT count(*)::int AS n FROM crm_contacts')).rows[0].n;
  assert.equal(after, before, 'no contact without something to identify them by');
});

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

test('ATTRIBUTION IS NOT INVENTED WHEN IT IS NOT KNOWN', async () => {
  // The source table is only written after somebody accepts the consent bar.
  // For a visitor who declined there is no source, and "unknown" is the
  // honest answer — calling it Direct would fill the reports with people who
  // actually came from Instagram.
  await crm.captureSubmission({ email: 'noconsent@example.com', formName: 'Contact form' });
  const r = await pool.query('SELECT source, source_known FROM crm_contacts WHERE email = $1',
    ['noconsent@example.com']);
  assert.equal(r.rows[0].source, null);
  assert.equal(r.rows[0].source_known, false, 'and it says so explicitly');
});

test('attribution is read from the session the site already records', async () => {
  await pool.query(
    `INSERT INTO analytics_sessions (session_id, visitor_id, source, medium, campaign, referrer_host)
     VALUES ('sess-crm-1', 'vis-1', 'Instagram', 'social', 'spring-push', 'instagram.com')`);
  const attribution = await crm.attributionFor('sess-crm-1');
  assert.equal(attribution.source, 'Instagram');
  assert.equal(attribution.utmMedium, 'social');
  assert.equal(attribution.utmCampaign, 'spring-push');
  assert.equal(attribution.referrerHost, 'instagram.com');
});

test('THE FIRST SOURCE IS KEPT, NOT THE LATEST', async () => {
  // Somebody arrives from Instagram, then comes back a week later by typing
  // the address. Overwriting would credit the second visit and eventually
  // attribute everybody to direct — which is how a channel that works
  // disappears from the reports.
  const email = 'returning@example.com';
  await crm.captureSubmission({ email, formName: 'a',
    attribution: { source: 'Instagram', utmCampaign: 'spring-push' } });
  await crm.captureSubmission({ email, formName: 'b',
    attribution: { source: 'Direct' } });

  const r = await pool.query('SELECT source, utm_campaign FROM crm_contacts WHERE email = $1', [email]);
  assert.equal(r.rows[0].source, 'Instagram');
  assert.equal(r.rows[0].utm_campaign, 'spring-push');
});

test('a source is filled in later if it was not known the first time', async () => {
  const email = 'lateattribution@example.com';
  await crm.captureSubmission({ email, formName: 'a' });                                  // declined consent
  await crm.captureSubmission({ email, formName: 'b', attribution: { source: 'Google' } }); // accepted later

  const r = await pool.query('SELECT source, source_known FROM crm_contacts WHERE email = $1', [email]);
  assert.equal(r.rows[0].source, 'Google', 'an unknown source is not protected from being learned');
  assert.equal(r.rows[0].source_known, true);
});

// ---------------------------------------------------------------------------
// Deals
// ---------------------------------------------------------------------------

test('AN ADVERTISING ENQUIRY OPENS A DEAL; A GENERAL QUESTION DOES NOT', async () => {
  await crm.captureSubmission({
    email: 'advertiser@example.com', fullName: 'Ad Vertiser',
    formName: 'Advertising enquiry', shape: 'advertising', message: 'rate card please' });
  await crm.captureSubmission({
    email: 'asker@example.com', formName: 'Contact form', message: 'what time is the event' });

  const withDeal = await pool.query(`
    SELECT d.* FROM crm_deals d JOIN crm_contacts c ON c.id = d.contact_id
     WHERE c.email = 'advertiser@example.com'`);
  assert.equal(withDeal.rowCount, 1);
  assert.equal(withDeal.rows[0].stage, 'prospect');
  assert.equal(withDeal.rows[0].source, 'advertising');

  const withoutDeal = await pool.query(`
    SELECT d.* FROM crm_deals d JOIN crm_contacts c ON c.id = d.contact_id
     WHERE c.email = 'asker@example.com'`);
  assert.equal(withoutDeal.rowCount, 0, 'the pipeline stays things somebody can close');
});

test('A SECOND ENQUIRY DOES NOT OPEN A SECOND DEAL', async () => {
  const email = 'keen@example.com';
  await crm.captureSubmission({ email, formName: 'Advertising enquiry', shape: 'advertising' });
  await crm.captureSubmission({ email, formName: 'Advertising enquiry', shape: 'advertising' });
  await crm.captureSubmission({ email, formName: 'Advertising enquiry', shape: 'advertising' });

  const deals = await pool.query(`
    SELECT d.* FROM crm_deals d JOIN crm_contacts c ON c.id = d.contact_id WHERE c.email = $1`, [email]);
  assert.equal(deals.rowCount, 1, 'one opportunity, however many times they ask');
});

test('a new deal opens once the previous one is closed', async () => {
  const email = 'repeat@example.com';
  await crm.captureSubmission({ email, formName: 'Advertising enquiry', shape: 'advertising' });
  const first = (await pool.query(`
    SELECT d.id FROM crm_deals d JOIN crm_contacts c ON c.id = d.contact_id WHERE c.email = $1`, [email])).rows[0];
  await pool.query(`UPDATE crm_deals SET stage = 'won', closed_at = now() WHERE id = $1`, [first.id]);

  await crm.captureSubmission({ email, formName: 'Advertising enquiry', shape: 'advertising' });
  const deals = await pool.query(`
    SELECT d.* FROM crm_deals d JOIN crm_contacts c ON c.id = d.contact_id WHERE c.email = $1`, [email]);
  assert.equal(deals.rowCount, 2, 'last year\'s customer coming back is a new opportunity');
});

// ---------------------------------------------------------------------------
// The pipeline API
// ---------------------------------------------------------------------------

test('the pipeline groups by stage and totals each column', async () => {
  const r = await api('GET', '/crm/pipeline');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.stages, ['prospect', 'contacted', 'proposal', 'won', 'lost']);
  assert.ok(r.body.deals.prospect.length > 0);
  assert.ok(typeof r.body.totals.prospect.value === 'number');
});

test('MOVING A DEAL TO WON STAMPS THE CLOSE DATE, AND MOVING IT BACK CLEARS IT', async () => {
  // Without the clearing, a deal dragged out of "won" by mistake keeps a close
  // date and every revenue figure that counts closed deals is quietly wrong.
  const deal = (await pool.query(`SELECT id FROM crm_deals WHERE stage = 'prospect' LIMIT 1`)).rows[0];

  let r = await api('PATCH', `/crm/deals/${deal.id}`, { stage: 'won' });
  assert.equal(r.status, 200);
  assert.ok(r.body.deal.closed_at, 'closing stamps the time');

  r = await api('PATCH', `/crm/deals/${deal.id}`, { stage: 'proposal' });
  assert.equal(r.body.deal.closed_at, null, 'reopening clears it');
});

test('a stage change is written to the timeline', async () => {
  const deal = (await pool.query(`SELECT id, contact_id FROM crm_deals LIMIT 1`)).rows[0];
  await api('PATCH', `/crm/deals/${deal.id}`, { stage: 'contacted' });
  const moves = await pool.query(
    `SELECT * FROM crm_activities WHERE deal_id = $1 AND kind = 'system'`, [deal.id]);
  assert.ok(moves.rowCount > 0, '"why did this stall" is only answerable if the moves were recorded');
});

test('an invalid stage or a negative value is refused', async () => {
  const deal = (await pool.query('SELECT id FROM crm_deals LIMIT 1')).rows[0];
  assert.equal((await api('PATCH', `/crm/deals/${deal.id}`, { stage: 'nonsense' })).status, 400);
  assert.equal((await api('PATCH', `/crm/deals/${deal.id}`, { value: -100 })).status, 400);
  assert.equal((await api('PATCH', `/crm/deals/${deal.id}`, { probability: 500 })).status, 400);
});

// ---------------------------------------------------------------------------
// The numbers
// ---------------------------------------------------------------------------

test('THE CLOSE RATE IS NULL BEFORE ANYTHING HAS CLOSED, NOT ZERO', async () => {
  // "No close rate yet" and "a close rate of zero" are different facts, and
  // showing 0% on a new pipeline is a statement about performance that is not
  // true.
  await pool.query(`UPDATE crm_deals SET stage = 'prospect', closed_at = NULL`);
  const r = await api('GET', '/crm/dashboard');
  assert.equal(r.body.closeRate.percent, null);
});

test('the close rate counts only decided deals', async () => {
  const ids = (await pool.query('SELECT id FROM crm_deals ORDER BY id LIMIT 4')).rows.map((x) => x.id);
  await pool.query(`UPDATE crm_deals SET stage = 'won', value = 1000, closed_at = now() WHERE id = ANY($1)`, [ids.slice(0, 3)]);
  await pool.query(`UPDATE crm_deals SET stage = 'lost', closed_at = now() WHERE id = $1`, [ids[3]]);

  const r = await api('GET', '/crm/dashboard');
  assert.equal(r.body.closeRate.won, 3);
  assert.equal(r.body.closeRate.lost, 1);
  assert.equal(r.body.closeRate.percent, 75, 'open deals are not counted as losses');
});

test('THE FORECAST IS WEIGHTED BY PROBABILITY', async () => {
  // The raw total assumes every open deal closes, which is the number that
  // gets a magazine into trouble.
  // Its own open deal. The previous test closed every existing one, and a
  // test that depends on what an earlier test left behind is a test that
  // fails for reasons that have nothing to do with what it is checking.
  const contact = (await pool.query('SELECT id FROM crm_contacts LIMIT 1')).rows[0];
  await pool.query(
    `INSERT INTO crm_deals (contact_id, title, stage, value, probability, source)
     VALUES ($1, 'Forecast test deal', 'proposal', 1000, 50, 'advertising')`, [contact.id]);

  const r = await api('GET', '/crm/dashboard');
  assert.ok(r.body.forecast.raw > 0);
  assert.ok(r.body.forecast.weighted < r.body.forecast.raw,
    `weighted (${r.body.forecast.weighted}) must be below raw (${r.body.forecast.raw})`);
  assert.equal(r.body.forecast.weighted, Math.round(r.body.forecast.raw * 0.5));
});

test('revenue is reported by month, from closed deals only', async () => {
  const r = await api('GET', '/crm/dashboard');
  assert.ok(Array.isArray(r.body.revenueByMonth));
  const total = r.body.revenueByMonth.reduce((s, m) => s + m.value, 0);
  assert.equal(total, 3000,
    'the three won deals at 1000 each — the open forecast deal is not revenue');
});

// ---------------------------------------------------------------------------
// Tasks and access
// ---------------------------------------------------------------------------

test('a task can be created, listed and completed', async () => {
  const contact = (await pool.query('SELECT id FROM crm_contacts LIMIT 1')).rows[0];
  const created = await api('POST', '/crm/tasks',
    { title: 'Call about the rate card', contactId: contact.id, dueAt: new Date().toISOString() });
  assert.equal(created.status, 201);

  const listed = await api('GET', '/crm/tasks');
  assert.ok(listed.body.tasks.some((t) => t.id === created.body.task.id));

  const done = await api('PATCH', `/crm/tasks/${created.body.task.id}`, { done: true });
  assert.equal(done.status, 200);
  assert.ok(done.body.task.done_at, 'completion is a time, so "when" is answerable');

  // Completing it twice is refused rather than moving the timestamp.
  assert.equal((await api('PATCH', `/crm/tasks/${created.body.task.id}`, { done: true })).status, 404);
});

test('an overdue task is marked overdue', async () => {
  const created = await api('POST', '/crm/tasks',
    { title: 'Overdue thing', dueAt: new Date(Date.now() - 86400000).toISOString() });
  const listed = await api('GET', '/crm/tasks');
  const task = listed.body.tasks.find((t) => t.id === created.body.task.id);
  assert.equal(task.overdue, true);
});

test('the contact record carries the whole timeline', async () => {
  const contact = (await pool.query(
    `SELECT id FROM crm_contacts WHERE email = 'thandi@example.com'`)).rows[0];
  const r = await api('GET', `/crm/contacts/${contact.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.contact.email, 'thandi@example.com');
  assert.equal(r.body.activities.length, 3);
  assert.ok(Array.isArray(r.body.deals));
  assert.ok(Array.isArray(r.body.tasks));
});

test('THE WHOLE CRM IS ADMIN-ONLY', async () => {
  const memberToken = jwt.sign(
    { id: 990002, email: 'crmmember@test.com', role: 'member' }, process.env.JWT_SECRET);
  for (const path of ['/crm/pipeline', '/crm/contacts', '/crm/dashboard', '/crm/tasks']) {
    assert.equal((await api('GET', path, null, null)).status, 401, `${path} without a token`);
    assert.equal((await api('GET', path, null, memberToken)).status, 403, `${path} as a member`);
  }
});
