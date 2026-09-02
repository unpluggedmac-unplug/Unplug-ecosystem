// My Invoices (spec §10.5).
//
// An invoice is a document that states what somebody was charged. It gets
// tested like one:
//
//   1. THE NUMBER IS STABLE AND NEVER REUSED. A number that changes between
//      views is not an invoice number, and two invoices sharing one is worse.
//   2. THE MONEY IS A SNAPSHOT. What was charged when it was issued, which must
//      not change afterwards because something else did.
//   3. VAT IS THE PORTION INSIDE THE TOTAL. Prices here are VAT-INCLUSIVE, so
//      R400 holds R52.17 of VAT — not R60. Getting that backwards overstates
//      the tax on every invoice the business issues.
//   4. IT SAYS "TAX INVOICE" ONLY WHEN IT MAY. Only a registered vendor can
//      issue one, so the claim is earned by having a registration number.
//   5. IT IS THE OWNER'S ALONE, and a stranger cannot even learn that a given
//      invoice exists.
//   6. NO INVOICE FOR MONEY THAT NEVER ARRIVED.

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
let tokenMine;
let tokenOther;
let inv;                 // utils/invoices, required after DATABASE_URL is set
let confirmedOrderId;
let pendingOrderId;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-myinv-'));
const port = 52000 + (process.pid % 300);
const ME = 980001;
const OTHER = 980002;

async function api(urlPath, tok) {
  const res = await fetch(baseUrl + urlPath, {
    headers: tok ? { Authorization: 'Bearer ' + tok } : {},
  });
  const type = res.headers.get('content-type') || '';
  if (type.includes('application/pdf')) {
    return { status: res.status, pdf: Buffer.from(await res.arrayBuffer()) };
  }
  return { status: res.status, body: await res.json().catch(() => null) };
}

// confirmed_at is worked out here rather than with a CASE on $3. Reusing one
// parameter as both a varchar value and a text comparison makes Postgres deduce
// two types for it and refuse the statement outright.
async function makeOrder(userId, reference, status, money = {}) {
  const confirmedAt = status === 'confirmed' ? (money.confirmedAt ?? new Date()) : null;
  const r = await pool.query(
    `INSERT INTO orders (user_id, reference, method, status, subtotal,
                         voucher_code, voucher_discount, credit_used, total,
                         terms_version, terms_accepted_at, info_confirmed_at, confirmed_at)
     VALUES ($1,$2,'eft',$3,$4,$5,$6,$7,$8,'v1', now(), now(), $9)
     RETURNING id`,
    [userId, reference, status,
      money.subtotal ?? 545, money.voucherCode ?? null, money.voucher ?? 45,
      money.credit ?? 100, money.total ?? 400, confirmedAt]);
  return r.rows[0].id;
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
  process.env.JWT_SECRET = 'test-secret-my-invoices';
  process.env.UNPLUG_DISABLE_RATE_LIMITS = '1';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(dir, f), 'utf8'));
  }

  inv = require('../src/utils/invoices');

  const jwt = require('jsonwebtoken');
  const express = require('express');
  const { attachUser } = require('../src/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/my', require('../src/routes/mySubmissions'));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await pool.query(
    `INSERT INTO users (id, email, full_name, password_hash, role)
     VALUES ($1,'me@inv.test','Thandi Mokoena','x','member'),
            ($2,'other@inv.test','Someone Else','x','member')`, [ME, OTHER]);
  tokenMine = jwt.sign({ id: ME, email: 'me@inv.test', role: 'member' }, process.env.JWT_SECRET);
  tokenOther = jwt.sign({ id: OTHER, email: 'other@inv.test', role: 'member' }, process.env.JWT_SECRET);

  confirmedOrderId = await makeOrder(ME, 'UNP-INV-1', 'confirmed');
  pendingOrderId = await makeOrder(ME, 'UNP-INV-2', 'pending');
  await pool.query(
    `INSERT INTO payments (user_id, linked_type, linked_id, amount, status, method,
                           gateway_reference, order_id)
     VALUES ($1,'article_publish',1,95.00,'confirmed','eft','GW-INV-A',$2),
            ($1,'ad_banner',2,450.00,'confirmed','eft','GW-INV-B',$2)`,
    [ME, confirmedOrderId]);
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
});

// ------------------------------------------------------------ the number

test('AN INVOICE IS ISSUED FOR A CONFIRMED ORDER', async () => {
  const invoice = await inv.issueForOrder(confirmedOrderId);
  assert.ok(invoice, 'a confirmed order should get an invoice');
  assert.match(invoice.invoice_number, /^INV-\d{4}-\d{6}$/,
    `unexpected format: ${invoice.invoice_number}`);
  assert.equal(invoice.reference, 'UNP-INV-1');
});

test('NO INVOICE FOR MONEY THAT NEVER ARRIVED', async () => {
  // A document saying somebody paid, for an order they have not paid, is worse
  // than no document.
  const invoice = await inv.issueForOrder(pendingOrderId);
  assert.equal(invoice, null);
  const rows = await pool.query('SELECT * FROM invoices WHERE order_id = $1', [pendingOrderId]);
  assert.equal(rows.rowCount, 0);
});

test('ISSUING TWICE DOES NOT MINT A SECOND NUMBER', async () => {
  // A retried webhook must not give one order two invoice numbers.
  const before = await pool.query('SELECT invoice_number FROM invoices WHERE order_id = $1',
    [confirmedOrderId]);
  const second = await inv.issueForOrder(confirmedOrderId);
  assert.equal(second, null, 'the second attempt should issue nothing');

  const after = await pool.query('SELECT invoice_number FROM invoices WHERE order_id = $1',
    [confirmedOrderId]);
  assert.equal(after.rowCount, 1, 'still exactly one invoice for this order');
  assert.equal(after.rows[0].invoice_number, before.rows[0].invoice_number,
    'and the same number as before');
});

test('THE NUMBER IS STABLE ACROSS READS', async () => {
  const first = await api('/my/invoices', tokenMine);
  const again = await api('/my/invoices', tokenMine);
  const a = first.body.invoices.find((i) => i.reference === 'UNP-INV-1');
  const b = again.body.invoices.find((i) => i.reference === 'UNP-INV-1');
  assert.equal(a.invoice_number, b.invoice_number);
});

test('numbers are never reused', async () => {
  const o1 = await makeOrder(ME, 'UNP-INV-3', 'confirmed');
  const o2 = await makeOrder(ME, 'UNP-INV-4', 'confirmed');
  const i1 = await inv.issueForOrder(o1);
  const i2 = await inv.issueForOrder(o2);
  assert.notEqual(i1.invoice_number, i2.invoice_number);

  const all = await pool.query('SELECT invoice_number FROM invoices');
  const numbers = all.rows.map((r) => r.invoice_number);
  assert.equal(new Set(numbers).size, numbers.length, 'a number was reused');
});

test('the year on the number is the year it was PAID, not the year it was read', async () => {
  // Backfilled invoices must not all claim to be from whenever the migration
  // happened to run.
  const oldId = await makeOrder(ME, 'UNP-OLD-1', 'confirmed',
    { subtotal: 95, voucher: 0, credit: 0, total: 95, confirmedAt: new Date('2024-03-04') });
  const invoice = await inv.issueForOrder(oldId);
  assert.ok(invoice.invoice_number.startsWith('INV-2024-'),
    `expected a 2024 number, got ${invoice.invoice_number}`);
});

// ----------------------------------------------------------- the snapshot

test('THE MONEY IS A SNAPSHOT, NOT A LIVE JOIN', async () => {
  // An invoice already given to a member must not change under them because
  // the order behind it was corrected later.
  const before = await api('/my/invoices', tokenMine);
  const mine = before.body.invoices.find((i) => i.reference === 'UNP-INV-1');
  assert.equal(mine.total, 400);

  await pool.query('UPDATE orders SET total = 9999, subtotal = 9999 WHERE id = $1',
    [confirmedOrderId]);

  const after = await api('/my/invoices', tokenMine);
  const still = after.body.invoices.find((i) => i.reference === 'UNP-INV-1');
  assert.equal(still.total, 400, 'the issued invoice must not follow the order');

  await pool.query('UPDATE orders SET total = 400, subtotal = 545 WHERE id = $1',
    [confirmedOrderId]);
});

test('the §10.4 money lines are all there and still add up', async () => {
  const res = await api(`/my/invoices`, tokenMine);
  const one = res.body.invoices.find((i) => i.reference === 'UNP-INV-1');
  assert.equal(one.subtotal, 545);
  assert.equal(one.voucher_discount, 45);
  assert.equal(one.credit_used, 100);
  assert.equal(one.total, 400);
  assert.equal(one.subtotal - one.voucher_discount - one.credit_used, one.total);
});

test('an invoice carries its lines, named for a person', async () => {
  const list = await api('/my/invoices', tokenMine);
  const one = list.body.invoices.find((i) => i.reference === 'UNP-INV-1');
  const res = await api(`/my/invoices/${one.id}`, tokenMine);
  assert.equal(res.status, 200);
  const labels = res.body.invoice.items.map((i) => i.label).sort();
  assert.deepEqual(labels, ['Advert', 'Article']);
});

// ----------------------------------------------------------------- VAT

test('VAT IS THE PORTION INSIDE THE TOTAL, NOT ADDED ON TOP', () => {
  // Prices here are VAT-inclusive. R400 holds R52.17 of VAT. Treating it as
  // 400 * 0.15 = 60.00 would overstate the tax on every invoice.
  const b = inv.vatBreakdown(400, 15);
  assert.equal(b.vat, 52.17);
  assert.equal(b.net, 347.83);
  assert.notEqual(b.vat, 60, 'that is VAT added on top, which is the wrong sum');
});

test('the parts always add back to the total exactly', () => {
  // Deriving net and VAT independently is how an invoice ends up a cent short
  // of itself. Checked across a spread of awkward amounts.
  for (const total of [0.01, 0.99, 1, 9.99, 95, 100, 123.45, 400, 999.99, 12345.67]) {
    const b = inv.vatBreakdown(total, 15);
    assert.equal(Number((b.net + b.vat).toFixed(2)), Number(total.toFixed(2)),
      `R${total} split into ${b.net} + ${b.vat}`);
  }
});

test('no VAT rate means no VAT', () => {
  const b = inv.vatBreakdown(400, 0);
  assert.equal(b.vat, 0);
  assert.equal(b.net, 400);
  assert.equal(b.inclusive, false);
});

test('IT ONLY CLAIMS TO BE A TAX INVOICE WHEN IT MAY', async () => {
  // Seeded empty on purpose: only a registered vendor may issue a tax invoice,
  // so with no registration number the document must not use the words and must
  // show no VAT line.
  const seeded = await pool.query(
    `SELECT value FROM settings WHERE key = 'vat_registration_number'`);
  assert.equal(seeded.rows[0].value, '', 'the number ships empty, for an admin to set');

  const before = await api('/my/invoices', tokenMine);
  const unregistered = before.body.invoices[0];
  assert.equal(unregistered.vatRegistered, false);
  assert.equal(unregistered.vatAmount, null, 'no VAT is claimed while unregistered');

  // Now register.
  await pool.query(
    `UPDATE settings SET value = '4123456789' WHERE key = 'vat_registration_number'`);
  const after = await api('/my/invoices', tokenMine);
  const registered = after.body.invoices.find((i) => i.reference === 'UNP-INV-1');
  assert.equal(registered.vatRegistered, true);
  assert.equal(registered.vatNumber, '4123456789');
  assert.equal(registered.vatRate, 15);
  assert.equal(registered.vatAmount, 52.17);
  assert.equal(registered.netAmount, 347.83);

  await pool.query(`UPDATE settings SET value = '' WHERE key = 'vat_registration_number'`);
});

test('whitespace is not a registration number', async () => {
  await pool.query(`UPDATE settings SET value = '   ' WHERE key = 'vat_registration_number'`);
  const res = await api('/my/invoices', tokenMine);
  assert.equal(res.body.invoices[0].vatRegistered, false);
  await pool.query(`UPDATE settings SET value = '' WHERE key = 'vat_registration_number'`);
});

// ------------------------------------------------------------- ownership

test('AN INVOICE IS THE OWNER\'S ALONE', async () => {
  const mine = await api('/my/invoices', tokenMine);
  assert.ok(mine.body.invoices.length > 0);

  const theirs = await api('/my/invoices', tokenOther);
  assert.deepEqual(theirs.body.invoices, [], 'they have none, and must not see mine');
});

test('a stranger cannot even learn that an invoice exists', async () => {
  // 404, not 403: confirming the existence of an invoice number to someone who
  // does not own it is itself a disclosure.
  const mine = await api('/my/invoices', tokenMine);
  const id = mine.body.invoices[0].id;
  const res = await api(`/my/invoices/${id}`, tokenOther);
  assert.equal(res.status, 404);
});

test('signed out gets nothing', async () => {
  assert.equal((await api('/my/invoices', null)).status, 401);
});

// ------------------------------------------------------------------ PDF

test('the document renders, and it is a PDF', async () => {
  const list = await api('/my/invoices', tokenMine);
  const id = list.body.invoices[0].id;
  const res = await api(`/my/invoices/${id}/pdf`, tokenMine);
  assert.equal(res.status, 200);
  assert.equal(res.pdf.subarray(0, 4).toString(), '%PDF', 'should be a real PDF');
  assert.ok(res.pdf.length > 800, 'and not an empty one');
});

test('someone else cannot download it', async () => {
  const list = await api('/my/invoices', tokenMine);
  const id = list.body.invoices[0].id;
  assert.equal((await api(`/my/invoices/${id}/pdf`, tokenOther)).status, 404);
});
