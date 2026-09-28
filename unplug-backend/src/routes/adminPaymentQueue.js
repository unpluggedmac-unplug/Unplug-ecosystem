// Unified payment/order administration queue.
const express = require('express');
const pool = require('../db');
const { requireRole } = require('../middleware/auth');
const { generateDocument } = require('../utils/pdfDocs');
const { sendEmail } = require('../utils/email');
const uploadsRouter = require('./uploads');
const { fetchPrivateObject, uploadPublicBuffer, r2Configured } = uploadsRouter;

const router = express.Router();

const SERVICE_LABELS = {
  profile_package: 'Directory Package', profile_upgrade: 'Package Upgrade',
  competition_entry: 'Competition Entry', highlight: 'Highlight',
  marketplace_listing: 'Marketplace Poster',
  article_publish: 'Article Submission', event_listing: 'Event Listing',
  gallery_bundle: 'Gallery Bundle', top10_entry: 'Top 10 Entry',
  edition_download: 'Edition Download', ad_banner: 'Page Banner',
  agreement_payment: 'Agreement',
};

// Payments and orders already use the statuses displayed by the unified queue.
function normalizeStatus(status) {
  return status;
}

async function queryPayments({ q, status, from, to }) {
  const conditions = ['p.order_id IS NULL']; // standalone only — order-linked ones surface as their parent order instead
  const values = [];
  if (status) { values.push(status); conditions.push(`p.status = $${values.length}`); }
  if (from) { values.push(from); conditions.push(`p.created_at >= $${values.length}`); }
  if (to) { values.push(to); conditions.push(`p.created_at <= $${values.length}`); }
  if (q) {
    values.push(`%${q}%`);
    conditions.push(`(p.gateway_reference ILIKE $${values.length}
      OR COALESCE(u.email, p.guest_payer_email, '') ILIKE $${values.length}
      OR COALESCE(u.full_name, p.guest_payer_name, '') ILIKE $${values.length})`);
  }
  const result = await pool.query(
    `SELECT p.id, p.gateway_reference AS reference, p.linked_type, p.amount, p.order_total,
            p.voucher_discount, p.credit_used, p.method, p.status, p.pop_url, p.invoice_url,
            p.receipt_url, p.created_at, p.confirmed_at, p.user_id,
            COALESCE(u.email, p.guest_payer_email) AS email,
            COALESCE(u.full_name, p.guest_payer_name) AS full_name
       FROM payments p LEFT JOIN users u ON u.id = p.user_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY p.created_at DESC
      LIMIT 500`,
    values
  );
  return result.rows.map((p) => ({
    source: 'payment',
    id: p.id,
    reference: p.reference,
    customerName: p.full_name,
    customerEmail: p.email,
    userId: p.user_id,
    serviceLabel: SERVICE_LABELS[p.linked_type] || p.linked_type,
    amount: Number(p.order_total != null ? p.order_total : p.amount),
    status: normalizeStatus(p.status),
    method: p.method,
    createdAt: p.created_at,
    confirmedAt: p.confirmed_at,
    popUrl: p.pop_url,
    invoiceUrl: p.invoice_url,
    receiptUrl: p.receipt_url,
  }));
}

async function queryOrders({ q, status, from, to }) {
  const conditions = [];
  const values = [];
  if (status) { values.push(status); conditions.push(`o.status = $${values.length}`); }
  if (from) { values.push(from); conditions.push(`o.created_at >= $${values.length}`); }
  if (to) { values.push(to); conditions.push(`o.created_at <= $${values.length}`); }
  if (q) {
    values.push(`%${q}%`);
    conditions.push(`(o.reference ILIKE $${values.length} OR u.email ILIKE $${values.length} OR u.full_name ILIKE $${values.length})`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await pool.query(
    `SELECT o.id, o.reference, o.total, o.method, o.status, o.pop_url, o.invoice_url, o.receipt_url,
            o.created_at, o.confirmed_at, o.user_id, u.email, u.full_name, COUNT(p.id)::int AS item_count
       FROM orders o
       JOIN users u ON u.id = o.user_id
       LEFT JOIN payments p ON p.order_id = o.id
       ${where}
      GROUP BY o.id, u.email, u.full_name
      ORDER BY o.created_at DESC
      LIMIT 500`,
    values
  );
  return result.rows.map((o) => ({
    source: 'order',
    id: o.id,
    reference: o.reference,
    customerName: o.full_name,
    customerEmail: o.email,
    userId: o.user_id,
    serviceLabel: `Cart order (${o.item_count} item${o.item_count === 1 ? '' : 's'})`,
    amount: Number(o.total),
    status: normalizeStatus(o.status),
    method: o.method,
    createdAt: o.created_at,
    confirmedAt: o.confirmed_at,
    popUrl: o.pop_url,
    invoiceUrl: o.invoice_url,
    receiptUrl: o.receipt_url,
  }));
}

// GET /admin/payment-queue — the merged list. q/status/from/to apply to
// every source queried; source narrows to just one when given.
router.get('/', requireRole('admin'), async (req, res, next) => {
  try {
    const filters = {
      q: (req.query.q || '').trim() || null,
      status: (req.query.status || '').trim() || null,
      from: (req.query.from || '').trim() || null,
      to: (req.query.to || '').trim() || null,
    };
    const wantSource = (req.query.source || '').trim();
    const runners = [];
    if (!wantSource || wantSource === 'payment') runners.push(queryPayments(filters));
    if (!wantSource || wantSource === 'order') runners.push(queryOrders(filters));
    const results = (await Promise.all(runners)).flat();
    results.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ items: results.slice(0, 500) });
  } catch (err) { next(err); }
});

// Loads one record fully — everything generate-invoice/receipt and email
// need: customer details, a reference, a status, and line items (an order
// has several; a standalone payment is exactly one).
async function loadRecord(source, id) {
  if (source === 'payment') {
    const r = await pool.query(
      `SELECT p.*,
              COALESCE(u.email, p.guest_payer_email) AS email,
              COALESCE(u.full_name, p.guest_payer_name) AS full_name
         FROM payments p LEFT JOIN users u ON u.id = p.user_id
        WHERE p.id = $1`,
      [id]
    );
    if (r.rowCount === 0) return null;
    const p = r.rows[0];
    // order_total is the FULL price before any discount, and amount is what's
    // actually owed/paid after voucher + credit come off — see the INSERT in
    // POST /payments/initiate for the exact reconciliation this mirrors.
    // Some pre-Phase-3 rows may have no order_total at all; reconstruct it
    // from amount + discounts rather than the other way around, since amount
    // (what was actually charged) is the one figure that's never missing.
    const total = Number(p.amount);
    const voucherDiscount = Number(p.voucher_discount || 0);
    const creditUsed = Number(p.credit_used || 0);
    const subtotal = p.order_total != null ? Number(p.order_total) : total + voucherDiscount + creditUsed;
    return {
      reference: p.gateway_reference, customerName: p.full_name, customerEmail: p.email,
      userId: p.user_id, method: p.method, status: p.status, createdAt: p.created_at,
      subtotal, voucherDiscount, creditUsed, total,
      items: [{ label: SERVICE_LABELS[p.linked_type] || p.linked_type, amount: total }],
      row: p,
    };
  }
  if (source === 'order') {
    const r = await pool.query(
      `SELECT o.*, u.email, u.full_name FROM orders o JOIN users u ON u.id = o.user_id WHERE o.id = $1`,
      [id]
    );
    if (r.rowCount === 0) return null;
    const o = r.rows[0];
    const items = await pool.query(`SELECT linked_type, amount FROM payments WHERE order_id = $1 ORDER BY id`, [id]);
    return {
      reference: o.reference, customerName: o.full_name, customerEmail: o.email,
      userId: o.user_id, method: o.method, status: o.status, createdAt: o.created_at,
      subtotal: Number(o.subtotal), voucherDiscount: Number(o.voucher_discount || 0), creditUsed: Number(o.credit_used || 0),
      total: Number(o.total),
      items: items.rows.map((i) => ({ label: SERVICE_LABELS[i.linked_type] || i.linked_type, amount: Number(i.amount) })),
      row: o,
    };
  }
  return null;
}

const TABLE_BY_SOURCE = { payment: 'payments', order: 'orders' };

function assertValidSource(source, res) {
  if (!TABLE_BY_SOURCE[source]) {
    res.status(400).json({ error: 'source must be payment or order.' });
    return false;
  }
  return true;
}

// GET /admin/payment-queue/:source/:id/proof — streams a proof-of-payment
// upload back to the admin. It lives in the PRIVATE bucket (see POST
// /uploads/proof), so this is the only way to actually view one.
router.get('/:source/:id/proof', requireRole('admin'), async (req, res, next) => {
  try {
    const { source, id } = req.params;
    if (!assertValidSource(source, res)) return;
    const table = TABLE_BY_SOURCE[source];
    const r = await pool.query(`SELECT pop_url FROM ${table} WHERE id = $1`, [Number(id)]);
    if (r.rowCount === 0 || !r.rows[0].pop_url) return res.status(404).json({ error: 'No proof of payment on file for this item.' });
    const upstream = await fetchPrivateObject(r.rows[0].pop_url);
    if (!upstream.ok || !upstream.body) return res.status(502).json({ error: 'Could not fetch that file right now.' });
    const contentType = upstream.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);
    const { Readable } = require('stream');
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) { next(err); }
});

// POST /admin/payment-queue/:source/:id/generate-invoice
// POST /admin/payment-queue/:source/:id/generate-receipt
async function generateAndStore(req, res, kind) {
  const { source, id } = req.params;
  if (!assertValidSource(source, res)) return;
  if (!r2Configured) {
    return res.status(400).json({ error: 'File storage is not configured on this server, so the generated document has nowhere to be saved.' });
  }
  const record = await loadRecord(source, Number(id));
  if (!record) return res.status(404).json({ error: 'Not found.' });

  const buffer = await generateDocument({
    kind,
    reference: record.reference,
    customerName: record.customerName,
    customerEmail: record.customerEmail,
    items: record.items,
    subtotal: record.subtotal,
    voucherDiscount: record.voucherDiscount,
    creditUsed: record.creditUsed,
    total: record.total,
    method: record.method,
    status: record.status,
    date: new Date(record.createdAt).toLocaleDateString('en-ZA'),
  });
  const filename = `${kind}-${record.reference}.pdf`;
  const url = await uploadPublicBuffer(buffer, filename, 'application/pdf');

  const table = TABLE_BY_SOURCE[source];
  const column = kind === 'receipt' ? 'receipt_url' : 'invoice_url';
  await pool.query(`UPDATE ${table} SET ${column} = $1 WHERE id = $2`, [url, Number(id)]);
  res.json({ url });
}

router.post('/:source/:id/generate-invoice', requireRole('admin'), (req, res, next) => {
  generateAndStore(req, res, 'invoice').catch(next);
});
router.post('/:source/:id/generate-receipt', requireRole('admin'), (req, res, next) => {
  generateAndStore(req, res, 'receipt').catch(next);
});

// POST /admin/payment-queue/:source/:id/email — a short, fixed-shape
// notification rather than a free-text composer: keeps this an admin
// utility for "let them know", not a general mailer with its own abuse
// surface. Mentions whichever of invoice/receipt already exists.
router.post('/:source/:id/email', requireRole('admin'), async (req, res, next) => {
  try {
    const { source, id } = req.params;
    if (!assertValidSource(source, res)) return;
    const record = await loadRecord(source, Number(id));
    if (!record) return res.status(404).json({ error: 'Not found.' });
    if (!record.customerEmail) return res.status(400).json({ error: 'There is no email address on file for this customer.' });

    const extraNote = String(req.body.note || '').trim();
    const lines = [
      `Hi${record.customerName ? ' ' + record.customerName : ''},`,
      '',
      `This is a note from Unplug Magazine about your order (reference ${record.reference}).`,
      `Status: ${record.status}. Total: R${record.total.toFixed(2)}.`,
    ];
    if (record.row.invoice_url) lines.push(`Invoice: ${record.row.invoice_url}`);
    if (record.row.receipt_url) lines.push(`Receipt: ${record.row.receipt_url}`);
    if (extraNote) lines.push('', extraNote);
    lines.push('', 'Thank you,', 'Unplug Magazine');

    await sendEmail({ to: record.customerEmail, subject: `Unplug Magazine — ${record.reference}`, text: lines.join('\n') });
    res.json({ message: `Email sent to ${record.customerEmail}.` });
  } catch (err) { next(err); }
});

module.exports = router;