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
const { stopPostgres } = require('./helpers/stopPostgres');

let pg;
let pool;
let server;
let pdfServer;
let baseUrl;
let pdfUrl;
let adminToken;
let editionId;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-dltest-'));
const port = 7600 + (process.pid % 300); // unique per test file: bases are 400 apart so the offset ranges cannot overlap
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
  const r = await req('POST', `/editions/${editionId}/purchase`, { body: { email, method: 'eft', termsAccepted: true } });
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
  if (privateServer) await new Promise((r) => privateServer.close(r));
  if (viewServer2) await new Promise((r) => viewServer2.close(r));
  if (pool) await pool.end();
  // stopPostgres, not pg.stop() directly: on Windows the library's stop
  // can HANG rather than throw, which used to leave the cluster running
  // with no parent and eventually broke a later test file's startup.
  // See test/helpers/stopPostgres.js.
  await stopPostgres(pg, dataDir);
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
    body: { email: 'cheap@test.com', method: 'eft', amount: 1, price: 1, downloadPrice: 1, termsAccepted: true },
  });
  const row = await pool.query('SELECT amount FROM edition_purchases WHERE id = $1', [r.body.purchaseId]);
  assert.equal(Number(row.rows[0].amount), 50, 'a posted amount overrode the real price');
});

test('a purchase is refused without accepting the Terms & Conditions — mandatory, no exceptions', async () => {
  const missing = await req('POST', `/editions/${editionId}/purchase`, { body: { email: 'noterms@test.com', method: 'eft' } });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /Terms/);

  const falseValue = await req('POST', `/editions/${editionId}/purchase`, { body: { email: 'noterms@test.com', method: 'eft', termsAccepted: false } });
  assert.equal(falseValue.status, 400);

  // No purchase row should exist for this email — rejection must happen
  // before the row is created, not after.
  const rows = await pool.query(`SELECT 1 FROM edition_purchases WHERE customer_email = 'noterms@test.com'`);
  assert.equal(rows.rows.length, 0);
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
  const buy = await req('POST', `/editions/${broken.rows[0].id}/purchase`, { body: { email: 'broken@test.com', method: 'eft', termsAccepted: true } });
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

// ----------------------------------------------------- member's own purchases

const memberToken = require('jsonwebtoken').sign(
  { id: 5, email: 'member@test.com', role: 'member' }, 'test-secret-for-edition-downloads'
);
//
// "My Editions" in the member dashboard. Two things matter: a member sees their
// own purchases (including ones made as a guest with the same email, since
// people buy first and register after), and the response never carries the
// download token or the PDF url — that would route around the single-use gate.

test('a member sees their own edition purchases, guest ones included', async () => {
  // edition_purchases.user_id is a real foreign key, so the member has to exist.
  await pool.query(`INSERT INTO users (id, email, password_hash, role)
                    VALUES (5, 'member@test.com', 'x', 'member') ON CONFLICT DO NOTHING`);
  // Bought while signed in.
  const asMember = await req('POST', `/editions/${editionId}/purchase`, {
    token: memberToken, body: { email: 'member@test.com', method: 'eft', termsAccepted: true },
  });
  assert.equal(asMember.status, 201, 'signed-in purchase failed: ' + JSON.stringify(asMember.body));
  // Bought as a guest, with the same email, before registering.
  const asGuest = await req('POST', `/editions/${editionId}/purchase`, {
    body: { email: 'MEMBER@TEST.COM', method: 'eft', termsAccepted: true },
  });
  assert.equal(asGuest.status, 201, 'guest purchase failed: ' + JSON.stringify(asGuest.body));

  const r = await req('GET', '/editions/my-purchases', { token: memberToken });
  assert.equal(r.status, 200);
  assert.ok(r.body.purchases.length >= 2,
    'the guest purchase made with the same email is missing');
});

test('my-purchases never exposes the download token or the PDF url', async () => {
  const r = await req('GET', '/editions/my-purchases', { token: memberToken });
  const serialised = JSON.stringify(r.body);
  assert.ok(!/download_token/.test(serialised), 'the download token leaked to the member list');
  assert.ok(!/pdf_url/.test(serialised), 'the PDF url leaked to the member list');
  // The reference IS theirs to see — it is how they claim their download.
  assert.ok(r.body.purchases.every((p) => 'download_reference' in p));
});

test('my-purchases only offers a download once the payment is approved', async () => {
  const before = await req('GET', '/editions/my-purchases', { token: memberToken });
  assert.ok(before.body.purchases.every((p) => p.canDownload === false),
    'an unapproved purchase was offered as downloadable');
  assert.ok(before.body.purchases.some((p) => /Awaiting/i.test(p.statusLabel)));
});

test('a signed-out visitor cannot list purchases', async () => {
  assert.equal((await req('GET', '/editions/my-purchases')).status, 401);
});

test('replacing an edition PDF records the file it replaced', async () => {
  const original = await pool.query('SELECT pdf_url FROM editions WHERE id = $1', [editionId]);

  await req('PATCH', `/editions/${editionId}`, {
    token: adminToken, body: { pdfUrl: 'https://example.test/corrected.pdf' },
  });

  const versions = await pool.query(
    'SELECT pdf_url FROM edition_pdf_versions WHERE edition_id = $1 ORDER BY replaced_at DESC', [editionId]
  );
  assert.equal(versions.rowCount, 1, 'the replaced PDF was not recorded');
  assert.equal(versions.rows[0].pdf_url, original.rows[0].pdf_url);

  // Saving without touching the PDF must not add a spurious version row.
  await req('PATCH', `/editions/${editionId}`, { token: adminToken, body: { title: 'Renamed Only' } });
  const after = await pool.query('SELECT COUNT(*)::int AS n FROM edition_pdf_versions WHERE edition_id = $1', [editionId]);
  assert.equal(after.rows[0].n, 1, 'an unrelated edit logged a PDF replacement');
});

// ---------------------------------------------------------------------------
// download_pdf_url (094_edition_download_pdf.sql) — the private file behind
// the paid single-use download, separate from the free "View Online" pdf_url.
// A second local origin stands in for the private Supabase bucket, with
// different bytes, so "the download served the PRIVATE file, not the free
// one" is something these tests can actually prove rather than assume.
// ---------------------------------------------------------------------------
let privateServer;
let viewServer2;
let privatePdfUrl;
let viewOnlyPdfUrl;
let dualFileEditionId;
const PRIVATE_PDF_BODY = '%PDF-1.4\n' + 'PRIVATE-DOWNLOAD-COPY-'.repeat(50) + '\n%%EOF';

test('setup: a second edition with separate view/download files', async () => {
  privateServer = http.createServer((_r, res) => {
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': Buffer.byteLength(PRIVATE_PDF_BODY) });
    res.end(PRIVATE_PDF_BODY);
  });
  await new Promise((r) => privateServer.listen(0, r));
  privatePdfUrl = `http://127.0.0.1:${privateServer.address().port}/private.pdf`;

  viewServer2 = http.createServer((_r, res) => {
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': Buffer.byteLength(PDF_BODY) });
    res.end(PDF_BODY);
  });
  await new Promise((r) => viewServer2.listen(0, r));
  viewOnlyPdfUrl = `http://127.0.0.1:${viewServer2.address().port}/view.pdf`;

  const ed = await pool.query(
    `INSERT INTO editions (issue_number, title, pdf_url, download_pdf_url, download_price, status, publication_date)
     VALUES (2, 'September 2026', $1, $2, 50.00, 'published', '2026-09-01') RETURNING id`,
    [viewOnlyPdfUrl, privatePdfUrl]
  );
  dualFileEditionId = ed.rows[0].id;
});

test('the paid download serves download_pdf_url, not the free View Online file', async () => {
  const purchase = await req('POST', `/editions/${dualFileEditionId}/purchase`, { body: { email: 'dualfile@test.com', method: 'eft', termsAccepted: true } });
  assert.equal(purchase.status, 201);
  await approve(purchase.body.purchaseId);
  const claim = await req('POST', '/editions/download/claim', { body: { email: 'dualfile@test.com', reference: purchase.body.reference } });
  assert.equal(claim.status, 200, JSON.stringify(claim.body));

  const download = await fetch(baseUrl + claim.body.downloadPath);
  const bytes = await download.text();
  assert.equal(download.status, 200);
  assert.match(bytes, /PRIVATE-DOWNLOAD-COPY-/, 'the download did not serve the private download_pdf_url file');
});

test('an edition with no separate download_pdf_url still downloads (falls back to pdf_url)', async () => {
  // A fresh edition, not the original `editionId` — an earlier test
  // ("replacing an edition PDF records the file it replaced") already
  // patched editionId's pdf_url to a fake, unreachable
  // https://example.test/corrected.pdf, which would make this test fail
  // for a reason unrelated to the fallback logic it's meant to check.
  const ed = await pool.query(
    `INSERT INTO editions (issue_number, title, pdf_url, download_price, status, publication_date)
     VALUES (3, 'October 2026', $1, 50.00, 'published', '2026-10-01') RETURNING id`, [pdfUrl]
  );
  const noDownloadFileEditionId = ed.rows[0].id;

  const purchase = await req('POST', `/editions/${noDownloadFileEditionId}/purchase`, { body: { email: 'fallback@test.com', method: 'eft', termsAccepted: true } });
  assert.equal(purchase.status, 201);
  await approve(purchase.body.purchaseId);
  const claim = await req('POST', '/editions/download/claim', { body: { email: 'fallback@test.com', reference: purchase.body.reference } });
  assert.equal(claim.status, 200, JSON.stringify(claim.body));

  const download = await fetch(baseUrl + claim.body.downloadPath);
  assert.equal(download.status, 200);
});

test('download_pdf_url never appears in the public edition list or detail routes', async () => {
  const list = await req('GET', '/editions');
  assert.ok(!/download_pdf_url/.test(JSON.stringify(list.body)), 'download_pdf_url leaked via GET /editions');

  const detail = await req('GET', `/editions/${dualFileEditionId}`);
  assert.equal(detail.status, 200);
  assert.ok(!('download_pdf_url' in detail.body.edition), 'download_pdf_url leaked via GET /editions/:id');
  // pdf_url (the free View Online file) is fine to still be there.
  assert.ok('pdf_url' in detail.body.edition);

  const latest = await req('GET', '/editions/latest');
  assert.ok(!/download_pdf_url/.test(JSON.stringify(latest.body)), 'download_pdf_url leaked via GET /editions/latest');
});

test('download_pdf_url is visible to admin (GET /editions/admin/all), unlike the public routes', async () => {
  const admin = await req('GET', '/editions/admin/all', { token: adminToken });
  const found = admin.body.editions.find((e) => e.id === dualFileEditionId);
  assert.ok(found);
  assert.equal(found.download_pdf_url, privatePdfUrl);
});
