// Paid edition downloads (Phase 2) — the access-control rules, over real HTTP
// against real PostgreSQL and a real PDF served by a local origin.
//
// This is money-and-access code, so the tests are written as the attacks they
// have to survive:
//   - a stranger with a leaked reference code but a different email
//   - a customer trying to download twice
//   - two clicks landing at the same instant
//   - claiming before the EFT has been approved
//   - a customer whose connection drops mid-download (must NOT lose their copy)
//
// Run with:  npm test   (from unplug-backend/)

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const EmbeddedPostgres = require('embedded-postgres').default;

let pg;
let pool;
let server;
let pdfServer;
let baseUrl;
let pdfUrl;
let adminToken;
let editionId;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-dltest-'));
const port = 6810 + (process.pid % 300);
const PDF_BODY = '%PDF-1.4\n' + 'x'.repeat(4096) + '\n%%EOF';

async function req(method, urlPath, { token, body } = {}) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* binary or empty */ }
  return { status: res.status, body: json, res };
}

// Buys an edition by EFT and returns { reference, purchaseId }.
async function buyByEft(email) {
  const r = await req('POST', `/editions/${editionId}/purchase`, { body: { email, method: 'eft' } });
  assert.equal(r.status, 201, 'purchase failed: ' + JSON.stringify(r.body));
  return r.body;
}

async function approve(purchaseId) {
  return req('POST', `/editions/admin/purchases/${purchaseId}/approve`, { token: adminToken });
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
  process.env.JWT_SECRET = 'test-secret-for-edition-downloads';
  // These tests hammer the public purchase endpoint far harder than a person
  // would; the limiter is verified separately, not here.
  process.env.UNPLUG_DISABLE_RATE_LIMITS = '1';
  // No email provider configured in tests: sendEmail throws, which is exactly
  // the "approved but the email failed" path we want to see handled.

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }

  const jwt = require('jsonwebtoken');
  adminToken = jwt.sign({ id: 1, email: 'admin@test', role: 'admin' }, process.env.JWT_SECRET);
  await pool.query(`INSERT INTO users (id, email, password_hash, role)
                    VALUES (1, 'admin@test', 'x', 'admin') ON CONFLICT DO NOTHING`);

  // Stands in for Supabase Storage — a plain origin serving the PDF bytes.
  pdfServer = http.createServer((_r, res) => {
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': Buffer.byteLength(PDF_BODY) });
    res.end(PDF_BODY);
  });
  await new Promise((r) => pdfServer.listen(0, r));
  pdfUrl = `http://127.0.0.1:${pdfServer.address().port}/edition.pdf`;

  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/editions', require('../src/routes/editions'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const ed = await pool.query(
    `INSERT INTO editions (issue_number, title, pdf_url, download_price, status, publication_date)
     VALUES (1, 'August 2026', $1, 50.00, 'published', '2026-08-01') RETURNING id`, [pdfUrl]
  );
  editionId = ed.rows[0].id;
}, { timeout: 120000 });

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (pdfServer) await new Promise((r) => pdfServer.close(r));
  if (pool) await pool.end();
  if (pg) await pg.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// -------------------------------------------------------------- reference code

test('the reference code is exactly 10 unambiguous characters', async () => {
  const p = await buyByEft('ref@test.com');
  assert.match(p.reference, /^[A-HJ-NP-Z2-9]{10}$/,
    `reference "${p.reference}" is not 10 chars of the unambiguous alphabet`);
});

test('reference codes are unique across purchases', async () => {
  const seen = new Set();
  for (let i = 0; i < 25; i++) {
    const p = await buyByEft(`bulk${i}@test.com`);
    assert.ok(!seen.has(p.reference), 'a reference code was issued twice');
    seen.add(p.reference);
  }
});

test('the price comes from the edition, not from the request', async () => {
  const r = await req('POST', `/editions/${editionId}/purchase`, {
    body: { email: 'cheap@test.com', method: 'eft', amount: 1, price: 1, downloadPrice: 1 },
  });
  const row = await pool.query('SELECT amount FROM edition_purchases WHERE id = $1', [r.body.purchaseId]);
  assert.equal(Number(row.rows[0].amount), 50, 'a posted amount overrode the real price');
});

test('an unpublished edition cannot be bought', async () => {
  const draft = await pool.query(
    `INSERT INTO editions (issue_number, title, pdf_url, status) VALUES (99, 'Draft', $1, 'draft') RETURNING id`,
    [pdfUrl]
  );
  const r = await req('POST', `/editions/${draft.rows[0].id}/purchase`, { body: { email: 'x@test.com', method: 'eft' } });
  assert.equal(r.status, 404);
});

test('a bad email address is refused', async () => {
  const r = await req('POST', `/editions/${editionId}/purchase`, { body: { email: 'not-an-email', method: 'eft' } });
  assert.equal(r.status, 400);
});

// ------------------------------------------------------------------ approval

test('an EFT purchase grants nothing until an admin approves it', async () => {
  const p = await buyByEft('waiting@test.com');
  const claim = await req('POST', '/editions/download/claim', {
    body: { email: 'waiting@test.com', reference: p.reference },
  });
  assert.equal(claim.status, 403);
  assert.match(claim.body.error, /awaiting approval/i);
});

test('only an admin can approve a payment', async () => {
  const jwt = require('jsonwebtoken');
  const memberToken = jwt.sign({ id: 5, email: 'member@test', role: 'member' }, process.env.JWT_SECRET);
  const p = await buyByEft('self@test.com');
  assert.equal((await req('POST', `/editions/admin/purchases/${p.purchaseId}/approve`, { token: memberToken })).status, 403);
  assert.equal((await req('POST', `/editions/admin/purchases/${p.purchaseId}/approve`)).status, 401);
});

test('approval still succeeds when the email cannot be sent, and says so', async () => {
  // No email provider is configured here. The customer has paid, so the
  // approval must stand and the admin must be told to pass on the reference.
  const p = await buyByEft('noemail@test.com');
  const r = await approve(p.purchaseId);
  assert.equal(r.status, 200);
  assert.equal(r.body.approved, true);
  assert.equal(r.body.emailed, false);
  assert.match(r.body.message, new RegExp(p.reference), 'the admin was not shown the reference to pass on');
});

test('approving twice is refused rather than re-sending access', async () => {
  const p = await buyByEft('double@test.com');
  assert.equal((await approve(p.purchaseId)).status, 200);
  assert.equal((await approve(p.purchaseId)).status, 409);
});

test('a rejected payment cannot claim a download', async () => {
  const p = await buyByEft('rejected@test.com');
  await req('POST', `/editions/admin/purchases/${p.purchaseId}/reject`, { token: adminToken, body: { reason: 'No funds received' } });
  const claim = await req('POST', '/editions/download/claim', {
    body: { email: 'rejected@test.com', reference: p.reference },
  });
  assert.equal(claim.status, 403);
});

test('rejecting does not delete the record', async () => {
  const row = await pool.query(`SELECT payment_status, rejected_reason FROM edition_purchases WHERE customer_email = 'rejected@test.com'`);
  assert.equal(row.rows[0].payment_status, 'rejected');
  assert.equal(row.rows[0].rejected_reason, 'No funds received');
});

// --------------------------------------------------------------- email + code

test('a leaked reference is useless with a different email address', async () => {
  const p = await buyByEft('owner@test.com');
  await approve(p.purchaseId);

  const stranger = await req('POST', '/editions/download/claim', {
    body: { email: 'stranger@test.com', reference: p.reference },
  });
  assert.equal(stranger.status, 404, 'a forwarded reference worked for someone else');

  // ...and the real buyer is unaffected by the failed attempt.
  const owner = await req('POST', '/editions/download/claim', {
    body: { email: 'owner@test.com', reference: p.reference },
  });
  assert.equal(owner.status, 200);
});

test('a wrong reference and a wrong email give the same answer', async () => {
  // Different messages would tell an attacker when they had found a real code.
  const a = await req('POST', '/editions/download/claim', { body: { email: 'owner@test.com', reference: 'ZZZZZZZZZZ' } });
  const b = await req('POST', '/editions/download/claim', { body: { email: 'nobody@test.com', reference: 'ZZZZZZZZZZ' } });
  assert.equal(a.status, b.status);
  assert.equal(a.body.error, b.body.error);
});

test('the claim response never contains the stored file URL', async () => {
  const p = await buyByEft('nourl@test.com');
  await approve(p.purchaseId);
  const claim = await req('POST', '/editions/download/claim', { body: { email: 'nourl@test.com', reference: p.reference } });
  assert.equal(claim.status, 200);
  assert.ok(!JSON.stringify(claim.body).includes(pdfUrl), 'the raw PDF URL was handed to the browser');
  assert.match(claim.body.downloadPath, /^\/editions\/download\/[a-f0-9]{64}$/);
});

// -------------------------------------------------------------- single use

test('the download delivers the PDF once', async () => {
  const p = await buyByEft('once@test.com');
  await approve(p.purchaseId);
  const claim = await req('POST', '/editions/download/claim', { body: { email: 'once@test.com', reference: p.reference } });

  const res = await fetch(baseUrl + claim.body.downloadPath);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  const body = await res.text();
  assert.equal(body, PDF_BODY, 'the delivered file did not match the edition PDF');

  const row = await pool.query(`SELECT download_count, download_status FROM edition_purchases WHERE id = $1`, [p.purchaseId]);
  assert.equal(row.rows[0].download_count, 1);
  assert.equal(row.rows[0].download_status, 'used');
});

test('the same link cannot be used a second time', async () => {
  const p = await buyByEft('twice@test.com');
  await approve(p.purchaseId);
  const claim = await req('POST', '/editions/download/claim', { body: { email: 'twice@test.com', reference: p.reference } });

  const first = await fetch(baseUrl + claim.body.downloadPath);
  assert.equal(first.status, 200);
  await first.text();

  const second = await fetch(baseUrl + claim.body.downloadPath);
  assert.equal(second.status, 410, 'the download link worked twice');
});

test('a used reference cannot be claimed again', async () => {
  const again = await req('POST', '/editions/download/claim', { body: { email: 'twice@test.com', reference: 'PLACEHOLDER' } });
  assert.equal(again.status, 404); // wrong code — separate check below
  const row = await pool.query(`SELECT download_reference FROM edition_purchases WHERE customer_email = 'twice@test.com'`);
  const real = await req('POST', '/editions/download/claim', {
    body: { email: 'twice@test.com', reference: row.rows[0].download_reference },
  });
  assert.equal(real.status, 410, 'a spent purchase issued another download link');
});

test('two simultaneous clicks deliver exactly one download', async () => {
  const p = await buyByEft('race@test.com');
  await approve(p.purchaseId);
  const claim = await req('POST', '/editions/download/claim', { body: { email: 'race@test.com', reference: p.reference } });

  const [a, b] = await Promise.all([
    fetch(baseUrl + claim.body.downloadPath),
    fetch(baseUrl + claim.body.downloadPath),
  ]);
  await Promise.all([a.text().catch(() => {}), b.text().catch(() => {})]);
  const ok = [a.status, b.status].filter((s) => s === 200).length;
  assert.equal(ok, 1, `expected exactly one success, got statuses ${a.status} and ${b.status}`);

  const row = await pool.query(`SELECT download_count FROM edition_purchases WHERE id = $1`, [p.purchaseId]);
  assert.equal(row.rows[0].download_count, 1);
});

test('an unknown token is rejected', async () => {
  const res = await fetch(baseUrl + '/editions/download/' + 'f'.repeat(64));
  assert.equal(res.status, 404);
});

test('a failed transfer does NOT consume the customer download', async () => {
  // The situation the spec calls out: the file cannot be fetched, so the
  // customer must keep the copy they paid for.
  const broken = await pool.query(
    `INSERT INTO editions (issue_number, title, pdf_url, status, publication_date)
     VALUES (500, 'Broken File', 'http://127.0.0.1:1/missing.pdf', 'published', '2026-08-01') RETURNING id`
  );
  const buy = await req('POST', `/editions/${broken.rows[0].id}/purchase`, { body: { email: 'broken@test.com', method: 'eft' } });
  await approve(buy.body.purchaseId);
  const claim = await req('POST', '/editions/download/claim', { body: { email: 'broken@test.com', reference: buy.body.reference } });

  const res = await fetch(baseUrl + claim.body.downloadPath);
  assert.ok(res.status >= 400, 'a broken file appeared to succeed');
  await res.text().catch(() => {});

  const row = await pool.query(`SELECT download_count, download_status FROM edition_purchases WHERE id = $1`, [buy.body.purchaseId]);
  assert.equal(row.rows[0].download_count, 0, 'the customer lost their download to a failed transfer');
  assert.equal(row.rows[0].download_status, 'available');
});

// --------------------------------------------------------------------- admin

test('the admin purchases list shows what is needed to match an EFT', async () => {
  const r = await req('GET', '/editions/admin/purchases', { token: adminToken });
  assert.equal(r.status, 200);
  const row = r.body.purchases.find((x) => x.customer_email === 'owner@test.com');
  assert.ok(row.download_reference, 'no reference to match against the bank statement');
  assert.equal(row.payment_method, 'eft');
  assert.equal(Number(row.amount), 50);
  assert.ok(row.edition_title);
});

test('the purchases list is admin-only', async () => {
  assert.equal((await req('GET', '/editions/admin/purchases')).status, 401);
});
