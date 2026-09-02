// FINDING A SUBMISSION'S REFERENCE.
//
// Spec §10.1: "The reference number becomes the link between User, Submission,
// Service, Payment, Admin approval, Invoice, Credit, Publication."
//
// That link exists today, but not as a column on the submission. It runs the
// other way: a payment row carries linked_type + linked_id pointing AT the
// submission, and the reference lives on the payment (or on the cart order the
// payment belongs to). Nothing joins back the other way, so given an article
// there was no way to ask "what reference is this under?" — which is what an
// admin searching a bank statement actually needs.
//
// This file is that join, written once.
//
// ---------------------------------------------------------------------------
// WHY A RESOLVER AND NOT A COLUMN
// ---------------------------------------------------------------------------
//
// The obvious alternative is a `reference` column on each of the nine
// submission tables, backfilled from its order. It was considered and rejected:
// that is a SECOND COPY of the one identifier that must never be ambiguous, and
// this codebase's recurring bug is a value stated twice. If the order's
// reference and the article's reference ever disagreed, neither would be
// trustworthy, and the bank statement would be the only arbiter.
//
// One copy, resolved on demand. If admin search ever proves too slow, that is
// the moment to denormalise — with a reason, and a test that the two agree.

const pool = require('../db');

// Which table each payment linked_type points at.
//
// Derived from applyPaymentEffect in payments.js, which is the code that acts
// on a confirmed payment and therefore the only authority on what linked_id
// means for each type. Constants — never built from a request.
const SUBMISSION_TABLE = {
  article_publish: 'articles',
  event_listing: 'events',
  profile_package: 'profiles',
  profile_upgrade: 'profile_upgrades',
  gallery_bundle: 'gallery_bundles',
  marketplace_listing: 'marketplace_listings',
  highlight: 'highlights',
  top10_entry: 'top10_entries',
  competition_entry: 'competition_entries',
  ad_banner: 'ad_slots',
  vote_bundle: 'vote_bundles',
  edition_download: 'edition_purchases',
  form_payment: 'form_submissions',
};

// The reverse: table -> the linked_types that point at it.
//
// profiles is reachable by two (a package purchase and an upgrade), which is
// why this is a list rather than a lookup. A resolver that assumed one type per
// table would silently miss upgrades.
const LINKED_TYPES_FOR = Object.entries(SUBMISSION_TABLE).reduce((acc, [type, table]) => {
  (acc[table] = acc[table] || []).push(type);
  return acc;
}, {});

// The reference a customer would quote for this submission.
//
// A payment bought through the cart belongs to an order, and the order's
// reference (UNP-…) is what the customer was shown and what they put on the
// EFT. A payment made on its own has only its gateway reference. Both are
// returned with `kind` saying which, because they look nothing alike and an
// admin matching a bank statement needs to know what they are looking at.
//
// Returns null when nothing has been paid — a draft article has no reference,
// and saying so is more useful than inventing one.
async function referenceFor(linkedType, linkedId, client = pool) {
  if (!SUBMISSION_TABLE[linkedType]) return null;
  const id = Number(linkedId);
  if (!Number.isInteger(id)) return null;

  const r = await client.query(
    `SELECT p.id AS payment_id, p.gateway_reference, p.status, p.created_at,
            o.id AS order_id, o.reference AS order_reference
       FROM payments p
       LEFT JOIN orders o ON o.id = p.order_id
      WHERE p.linked_type = $1 AND p.linked_id = $2
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT 1`,
    [linkedType, id]
  );
  if (!r.rows.length) return null;

  const row = r.rows[0];
  return row.order_reference
    ? {
      reference: row.order_reference,
      kind: 'order',
      orderId: row.order_id,
      paymentId: row.payment_id,
      paymentStatus: row.status,
    }
    : {
      reference: row.gateway_reference,
      kind: 'payment',
      orderId: null,
      paymentId: row.payment_id,
      paymentStatus: row.status,
    };
}

// The same question asked from the other end: given a reference a customer has
// quoted, what did they buy?
//
// Accepts either shape — the UNP- order reference or a bare gateway reference —
// because a customer reading a number off a bank statement does not know which
// kind they have, and asking them to work it out is not a reasonable request.
async function submissionsForReference(reference, client = pool) {
  const ref = String(reference || '').trim();
  if (!ref) return [];

  const r = await client.query(
    `SELECT p.id AS payment_id, p.linked_type, p.linked_id, p.status,
            o.reference AS order_reference, p.gateway_reference
       FROM payments p
       LEFT JOIN orders o ON o.id = p.order_id
      WHERE o.reference = $1 OR p.gateway_reference = $1
      ORDER BY p.id ASC`,
    [ref]
  );

  // One order can hold several services — that is the point of the cart — so
  // this returns a list rather than a single row.
  return r.rows.map((row) => ({
    linkedType: row.linked_type,
    linkedId: row.linked_id,
    table: SUBMISSION_TABLE[row.linked_type] || null,
    paymentId: row.payment_id,
    paymentStatus: row.status,
    kind: row.order_reference === ref ? 'order' : 'payment',
  }));
}

module.exports = {
  SUBMISSION_TABLE, LINKED_TYPES_FOR, referenceFor, submissionsForReference,
};
