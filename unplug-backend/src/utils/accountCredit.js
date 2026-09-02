// Account credit: the money side of the Refund & Cancellation Policy.
//
// The policy promises that a declined or cancelled paid submission comes back
// as credit rather than cash. This is where that promise is kept, so it is
// written to be hard to get wrong with money:
//
//   - the balance is always SUM(ledger), never a stored number that can drift;
//   - crediting a payment twice is blocked by a unique index, not by a check
//     that races;
//   - spending happens inside the caller's transaction, so credit can never be
//     deducted for a payment row that then fails to insert.
const pool = require('../db');

// Which admin content type corresponds to which payment. A submission is
// linked to its payment through payments.linked_type + linked_id, and this is
// the only place that mapping is written down.
//
// Some types are absent on purpose: an investor listing has no payment type,
// and an edition download is a completed purchase of a file, not a submission
// awaiting approval.
const RESOURCE_PAYMENT_TYPES = {
  articles: ['article_publish'],
  events: ['event_listing'],
  gallery: ['gallery_bundle'],
  profiles: ['profile_package', 'profile_upgrade'],
  entries: ['competition_entry'],
  'top10-entries': ['top10_entry'],
  marketplace: ['marketplace_listing'],
  highlights: ['highlight'],
};

async function balanceFor(userId, client = pool) {
  const result = await client.query(
    'SELECT COALESCE(SUM(amount), 0)::numeric AS balance FROM account_credits WHERE user_id = $1',
    [userId]
  );
  return Number(result.rows[0].balance);
}

// Why a line is on the ledger, in words a member can read.
//
// `reason` is a database enum — 'declined_submission' — and the dashboard used
// to show it with the underscores swapped for spaces, which is a column name
// wearing a hat. These are the sentences instead. Every value the CHECK allows
// must appear here; enforced below.
const REASON_LABEL = {
  declined_submission: 'Credit for a submission we could not approve',
  cancelled_service: 'Credit for a service you cancelled',
  admin_adjustment: 'Adjustment by Unplug',
  spent_at_checkout: 'Used at checkout',
};

const REASONS = ['declined_submission', 'cancelled_service', 'admin_adjustment', 'spent_at_checkout'];
for (const reason of REASONS) {
  if (!Object.prototype.hasOwnProperty.call(REASON_LABEL, reason)) {
    throw new Error(`accountCredit: reason '${reason}' has no member-facing wording`);
  }
}

function reasonLabel(reason) {
  const key = String(reason || '');
  return Object.prototype.hasOwnProperty.call(REASON_LABEL, key) ? REASON_LABEL[key] : key;
}

// The ledger, newest first.
//
// §10.7 says a credit must be recorded against the ORIGINAL REFERENCE and the
// original payment, so both are joined here rather than left as a bare
// payment_id. The reference is the only part of that a member recognises: it is
// what they were shown at checkout and what they put on their EFT.
//
// The order's reference wins over the payment's gateway reference for the same
// reason it does everywhere else — it is the one the customer was given.
//
// `created_by` (which admin) is deliberately NOT returned. §10.7 requires it to
// be RECORDED, and it is, on the row; showing a member which member of staff
// declined their submission is a different decision and not one this asks for.
async function historyFor(userId, client = pool) {
  const result = await client.query(
    `SELECT c.id, c.amount, c.reason, c.note, c.payment_id, c.created_at,
            COALESCE(o.reference, p.gateway_reference) AS reference,
            p.linked_type
       FROM account_credits c
       LEFT JOIN payments p ON p.id = c.payment_id
       LEFT JOIN orders o   ON o.id = p.order_id
      WHERE c.user_id = $1
      ORDER BY c.created_at DESC
      LIMIT 100`,
    [userId]
  );
  // Required lazily: submissionReference requires db, and requiring it at the
  // top of this file would build that pool before DATABASE_URL is read.
  const { serviceLabel } = require('./submissionReference');
  return result.rows.map((row) => ({
    ...row,
    reasonLabel: reasonLabel(row.reason),
    serviceName: row.linked_type ? serviceLabel(row.linked_type) : null,
  }));
}

// Find the confirmed payment behind a submission, if there is one.
//
// Only 'confirmed' counts. Crediting an unpaid or failed payment would hand
// out money that was never received.
async function findPaidPayment(resource, itemId, client = pool) {
  const types = RESOURCE_PAYMENT_TYPES[resource];
  if (!types) return null;
  const result = await client.query(
    `SELECT id, user_id, amount, credited_at, linked_type
       FROM payments
      WHERE linked_type = ANY($1) AND linked_id = $2 AND status = 'confirmed'
      ORDER BY created_at DESC
      LIMIT 1`,
    [types, itemId]
  );
  return result.rows[0] || null;
}

// Spend credit against a purchase. Returns how much was actually used.
//
// Takes a client rather than the pool because it MUST run in the same
// transaction as the payment insert — deducting credit and then failing to
// create the payment would quietly take money from the member.
async function spendCredit(client, userId, amountDue, note) {
  // Lock the member's row for the rest of the transaction before reading the
  // balance. Without this, two checkouts starting at the same moment would
  // both read the same R100, both spend it, and the account would end up
  // R100 in the red — the ledger is append-only, so nothing else would catch
  // it. Locking per user keeps different members from blocking each other.
  await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);

  const balance = await balanceFor(userId, client);
  if (balance <= 0 || amountDue <= 0) return 0;

  const used = Math.min(balance, amountDue);
  await client.query(
    `INSERT INTO account_credits (user_id, amount, reason, note)
     VALUES ($1, $2, 'spent_at_checkout', $3)`,
    [userId, -used, note || null]
  );
  return used;
}

module.exports = {
  RESOURCE_PAYMENT_TYPES,
  REASON_LABEL,
  REASONS,
  reasonLabel,
  balanceFor,
  historyFor,
  findPaidPayment,
  spendCredit,
};
