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

async function historyFor(userId, client = pool) {
  const result = await client.query(
    `SELECT id, amount, reason, note, payment_id, created_at
       FROM account_credits
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 100`,
    [userId]
  );
  return result.rows;
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
  balanceFor,
  historyFor,
  findPaidPayment,
  spendCredit,
};
