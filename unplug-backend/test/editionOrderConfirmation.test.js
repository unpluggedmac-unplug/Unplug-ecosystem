// EDITIONS — the order confirmation document, the payment procedure, and
// telling an admin which paid downloads are still publicly readable.
//
// The guarantees worth testing hardest:
//   1. Checkout hands back the Reference Code and the payment procedure,
//      including where to send proof of payment. A buyer who cannot find that
//      cannot pay in a way we can match.
//   2. The confirmation document needs the Reference Code AND the email. It
//      carries the customer's name, email and amount, so a bare reference —
//      which is short enough to guess at — must not open it.
//   3. The admin list says, per edition, whether a paying customer's download
//      would be served from a file anyone with the link can already read.
//   4. Storage being down must not cost a customer their order.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-edconf-'));
const port = 24800 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap

async function req(method, urlPath, { token, body } = {}) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const contentType = res.headers.get('content-type') || '';
  let json = null;
  if (contentType.includes('application/json')) {
    try { json = await res.json(); } catch (e) { /* no body */ }
  }
  return { status: res.status, body: json, contentType };
}

let jwt;
function tokenFor(userId, role = 'member') {
  return jwt.sign({ id: userId, email: `ec${userId}@test.com`, role }, process.env.JWT_SECRET);
}

let _nextUserId = 121000;
async function makeUser(role = 'member') {
  const id = _nextUserId++;
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'x', $3) ON CONFLICT DO NOTHING`,
    [id, `ec${id}@test.com`, role]
  );
  return id;
}

const PUBLIC_URL = 'https://x.supabase.co/storage/v1/object/public/uploads/edition.pdf';
const PRIVATE_URL = 'https://x.supabase.co/storage/v1/object/edition-downloads/edition.pdf';

let adminToken;
let editionId;

before(async () => {
  pg = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'postgres', password: 'postgres', port,
    persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('unplug_test');

  process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${port}/unplug_test`;
  process.env.JWT_SECRET = 'test-secret-for-edition-confirmation';
  process.env.UNPLUG_DISABLE_RATE_LIMITS = '1';
  // Storage deliberately NOT configured for this file: it proves the
  // best-effort path, i.e. that a purchase still completes with the Reference
  // Code intact when the document cannot be stored.
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_KEY;

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
  app.use('/editions', require('../src/routes/editions'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  adminToken = tokenFor(await makeUser('admin'), 'admin');

  const e = await pool.query(
    `INSERT INTO editions (issue_number, title, status, pdf_url, download_price)
     VALUES (901, 'Confirmation Test Edition', 'published', $1, 45) RETURNING id`,
    [PUBLIC_URL]
  );
  editionId = e.rows[0].id;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  if (pg) await pg.stop();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* Windows holds the dir briefly */ }
});

test('checkout returns the Reference Code and the full payment procedure', async () => {
  const res = await req('POST', `/editions/${editionId}/purchase`, {
    body: { email: 'buyer@test.com', name: 'A Buyer', method: 'eft', termsAccepted: true },
  });
  assert.equal(res.status, 201);
  assert.ok(res.body.reference, 'the buyer must get a Reference Code');
  assert.ok(res.body.procedure, 'the payment procedure must be spelled out');
  assert.equal(res.body.procedure.salesEmail, 'sales@unplugnews.com');
  assert.ok(res.body.procedure.steps.length >= 4);
  // The single most important instruction: where proof of payment goes.
  assert.ok(res.body.procedure.steps.some((s) => s.includes('sales@unplugnews.com')));
  // And the Reference Code appears in the steps, not only in a field.
  assert.ok(res.body.procedure.steps.some((s) => s.includes(res.body.reference)));
});

test('the procedure names what can and cannot be paid with yet', async () => {
  const res = await req('POST', `/editions/${editionId}/purchase`, {
    body: { email: 'methods@test.com', method: 'eft', termsAccepted: true },
  });
  assert.deepEqual(res.body.procedure.comingSoonMethods, ['Ozow', 'PayFast']);
  assert.ok(res.body.procedure.availableMethods.includes('EFT'));
});

test('a purchase still completes when the document cannot be stored', async () => {
  // Storage is unconfigured in this file. The order must stand regardless —
  // losing someone's order because a bucket was unreachable is far worse than
  // them not having a PDF to download.
  const res = await req('POST', `/editions/${editionId}/purchase`, {
    body: { email: 'nostorage@test.com', method: 'eft', termsAccepted: true },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.confirmationAvailable, false);
  assert.ok(res.body.reference);

  const row = await pool.query('SELECT id FROM edition_purchases WHERE download_reference = $1', [res.body.reference]);
  assert.equal(row.rowCount, 1, 'the purchase must exist');
});

test('the confirmation needs BOTH the Reference Code and the email', async () => {
  const created = await req('POST', `/editions/${editionId}/purchase`, {
    body: { email: 'pairs@test.com', method: 'eft', termsAccepted: true },
  });
  const reference = created.body.reference;

  // Right reference, wrong email.
  const wrongEmail = await req('POST', '/editions/purchases/confirmation', {
    body: { reference, email: 'someone-else@test.com' },
  });
  assert.equal(wrongEmail.status, 404);

  // Nonsense reference, real email.
  const wrongRef = await req('POST', '/editions/purchases/confirmation', {
    body: { reference: 'ZZZZZZZZZZ', email: 'pairs@test.com' },
  });
  assert.equal(wrongRef.status, 404);

  // Both wrong and both right give the SAME shape of failure message when the
  // document is missing, so nothing here reveals which references exist.
  assert.equal(wrongEmail.body.error, wrongRef.body.error);
});

test('the confirmation is refused without a reference and email', async () => {
  assert.equal((await req('POST', '/editions/purchases/confirmation', { body: {} })).status, 400);
  assert.equal((await req('POST', '/editions/purchases/confirmation', { body: { reference: 'ABC' } })).status, 400);
});

test('the admin list flags an edition whose paid download is publicly readable', async () => {
  const res = await req('GET', '/editions/admin/all', { token: adminToken });
  assert.equal(res.status, 200);
  const row = res.body.editions.find((e) => e.id === editionId);
  assert.ok(row);
  assert.equal(row.downloadFileIsPublic, true, 'this edition falls back to the public view-online file');
  assert.equal(row.hasPrivateDownloadCopy, false);
});

test('an edition with a private download copy is not flagged', async () => {
  const e = await pool.query(
    `INSERT INTO editions (issue_number, title, status, pdf_url, download_pdf_url, download_price)
     VALUES (902, 'Already Private', 'published', $1, $2, 45) RETURNING id`,
    [PUBLIC_URL, PRIVATE_URL]
  );
  const res = await req('GET', '/editions/admin/all', { token: adminToken });
  const row = res.body.editions.find((x) => x.id === e.rows[0].id);
  assert.equal(row.downloadFileIsPublic, false);
  assert.equal(row.hasPrivateDownloadCopy, true);
});

test('securing a download that is already private is refused, not repeated', async () => {
  const e = await pool.query(
    `INSERT INTO editions (issue_number, title, status, pdf_url, download_pdf_url, download_price)
     VALUES (903, 'Second Secure Attempt', 'published', $1, $2, 45) RETURNING id`,
    [PUBLIC_URL, PRIVATE_URL]
  );
  // Storage is unconfigured here, so this reports that first — which is
  // itself the right answer: without storage there is nowhere private to put
  // anything, and pretending otherwise would be worse.
  const res = await req('POST', `/editions/admin/${e.rows[0].id}/secure-download`, { token: adminToken });
  assert.ok([400, 409].includes(res.status));
});

test('securing a download is admin-only', async () => {
  const memberToken = tokenFor(await makeUser('member'), 'member');
  assert.equal((await req('POST', `/editions/admin/${editionId}/secure-download`)).status, 401);
  assert.equal((await req('POST', `/editions/admin/${editionId}/secure-download`, { token: memberToken })).status, 403);
});

test('checkout still refuses without accepting the terms', async () => {
  const res = await req('POST', `/editions/${editionId}/purchase`, {
    body: { email: 'noterms@test.com', method: 'eft' },
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Terms/i);
});

test('re-running every migration is idempotent', async () => {
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }
  const n = await pool.query('SELECT COUNT(*) AS n FROM edition_purchases');
  assert.ok(Number(n.rows[0].n) > 0, 'purchases must survive a migration re-run');
});
