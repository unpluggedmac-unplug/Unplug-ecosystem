// Invoices (spec §10.5).
//
// An invoice is a document that says what was charged. Two things follow from
// that and shape this whole file:
//
//   1. Its NUMBER must be stable. Allocated once, stored, never reused, never
//      recomputed. next_invoice_number() in migration 164 is the only thing
//      that mints one.
//   2. Its MONEY is a snapshot. Copied at issue, not joined at read, so an
//      invoice already given to a member cannot change under them.

const pool = require('../db');

// VAT, worked out the way VAT-INCLUSIVE pricing actually works.
//
// Unplug's prices include VAT, so the total is the gross and the VAT is the
// portion INSIDE it — not 15% added on top. For a 15% rate:
//
//   vat = total * 15/115        (NOT total * 0.15)
//   net = total - vat
//
// Getting this backwards overstates the tax on every invoice: R400 inclusive is
// R52.17 VAT, not R60.00. Rounded to cents, with the net derived by subtraction
// so net + vat always equals the total exactly — deriving both independently is
// how an invoice ends up a cent short of itself.
function vatBreakdown(total, ratePercent) {
  const gross = Number(total) || 0;
  const rate = Number(ratePercent);
  if (!Number.isFinite(rate) || rate <= 0) {
    return { rate: 0, vat: 0, net: round2(gross), inclusive: false };
  }
  const vat = round2(gross * (rate / (100 + rate)));
  return { rate, vat, net: round2(gross - vat), inclusive: true };
}

function round2(n) {
  // Rounded away from zero at the half cent, which is what a person doing this
  // by hand does. Number.EPSILON guards the usual binary-float near-misses
  // (1.005 is really 1.00499999…).
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// The VAT settings, as configured by an admin.
//
// The registration number is seeded EMPTY on purpose: it is a fact about the
// business, not something source control should invent. Until it is set, this
// reports vatRegistered:false and the document renders as a plain invoice with
// no VAT line — the safe direction to fail, because a tax invoice missing its
// registration number is worse than an invoice that does not claim to be one.
async function vatSettings(client = pool) {
  const r = await client.query(
    `SELECT key, value FROM settings WHERE key IN ('vat_registration_number', 'vat_rate')`
  );
  const map = Object.fromEntries(r.rows.map((row) => [row.key, row.value]));
  const number = String(map.vat_registration_number || '').trim();
  const rate = Number(map.vat_rate);
  return {
    vatNumber: number,
    vatRate: Number.isFinite(rate) && rate > 0 ? rate : 0,
    vatRegistered: number.length > 0,
  };
}

// Issue the invoice for a confirmed order, if it does not already have one.
//
// Called after an order is confirmed. Safe to call twice: the UNIQUE on
// order_id and the NOT EXISTS both refuse a second invoice for one order, so a
// retried webhook cannot mint a duplicate number.
//
// Takes the caller's client so it can run inside the same transaction that
// confirmed the order — an invoice for an order that then rolls back would be a
// document for a payment that never happened.
async function issueForOrder(orderId, client = pool) {
  const id = Number(orderId);
  if (!Number.isInteger(id)) return null;

  const r = await client.query(
    `INSERT INTO invoices (user_id, order_id, invoice_number, reference, issued_at,
                           subtotal, voucher_discount, credit_used, total, method, status)
     SELECT o.user_id, o.id,
            next_invoice_number(COALESCE(o.confirmed_at, now())),
            o.reference, COALESCE(o.confirmed_at, now()),
            o.subtotal, o.voucher_discount, o.credit_used, o.total, o.method, o.status
       FROM orders o
      WHERE o.id = $1
        AND o.status = 'confirmed'
        AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.order_id = o.id)
     RETURNING *`,
    [id]
  );
  return r.rows.length ? r.rows[0] : null;
}

// A member's invoices, newest first.
async function listFor(userId, client = pool) {
  const id = Number(userId);
  if (!Number.isInteger(id)) return [];
  const r = await client.query(
    `SELECT id, invoice_number, reference, issued_at, subtotal, voucher_discount,
            credit_used, total, method, status, order_id
       FROM invoices
      WHERE user_id = $1
      ORDER BY issued_at DESC, id DESC
      LIMIT 200`,
    [id]
  );
  const vat = await vatSettings(client);
  return r.rows.map((row) => withMoney(row, vat));
}

// One invoice, only ever the owner's.
//
// The ownership test is in the WHERE clause rather than in a check afterwards:
// a query that cannot return someone else's row is harder to get wrong than one
// that returns it and then remembers not to send it.
async function getForMember(userId, invoiceId, client = pool) {
  const uid = Number(userId);
  const iid = Number(invoiceId);
  if (!Number.isInteger(uid) || !Number.isInteger(iid)) return null;

  const r = await client.query(
    `SELECT * FROM invoices WHERE id = $1 AND user_id = $2`, [iid, uid]
  );
  if (!r.rows.length) return null;

  const vat = await vatSettings(client);
  const invoice = withMoney(r.rows[0], vat);

  // The lines, named the way they are named everywhere else.
  const { serviceLabel } = require('./submissionReference');
  const items = invoice.order_id
    ? await client.query(
      `SELECT linked_type, amount FROM payments WHERE order_id = $1 ORDER BY id ASC`,
      [invoice.order_id]
    )
    : { rows: [] };

  invoice.items = items.rows.map((i) => ({
    label: serviceLabel(i.linked_type),
    amount: Number(i.amount),
  }));
  return invoice;
}

// Numbers as numbers, plus the VAT split. One place, so a list row and a PDF
// cannot disagree about what the VAT on an invoice was.
function withMoney(row, vat) {
  const total = Number(row.total);
  const split = vat.vatRegistered ? vatBreakdown(total, vat.vatRate) : null;
  return {
    ...row,
    subtotal: Number(row.subtotal),
    voucher_discount: Number(row.voucher_discount),
    credit_used: Number(row.credit_used),
    total,
    vatRegistered: vat.vatRegistered,
    vatNumber: vat.vatNumber || null,
    vatRate: split ? split.rate : null,
    vatAmount: split ? split.vat : null,
    netAmount: split ? split.net : null,
  };
}

module.exports = {
  vatBreakdown, round2, vatSettings, issueForOrder, listFor, getForMember, withMoney,
};
