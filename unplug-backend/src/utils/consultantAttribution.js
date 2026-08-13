// Who earns the commission on a payment.
//
// Deliberately one small function in one file, rather than inline logic in
// payments.js and orders.js: this decides who gets paid, and two copies of it
// would eventually disagree with each other on somebody's payout.
//
// The rule (the owner's, 2026-08-13): the consultant a member picks at signup
// earns commission on that member's payments, unless an admin reassigns them.
//
//   1. assigned_consultant_id    — an admin said so; beats everything
//   2. acquisition_consultant_id — what the member said at signup
//   3. the consultant picked at this individual checkout — unchanged
//      behaviour, and the only rule that can apply to an anonymous buyer
//
// Returns { consultantId, source } — the source is stored on the payment so a
// disputed payout can be answered with "because the member chose them at
// signup" rather than a shrug.
const pool = require('../db');

async function resolveConsultant(userId, checkoutConsultantId, client = pool) {
  const fallback = checkoutConsultantId
    ? { consultantId: Number(checkoutConsultantId), source: 'checkout_selection' }
    : { consultantId: null, source: null };

  if (!userId) return fallback; // anonymous buyer — only the checkout answer exists

  const result = await client.query(
    `SELECT assigned_consultant_id, acquisition_consultant_id
       FROM users WHERE id = $1`,
    [userId]
  );
  if (result.rows.length === 0) return fallback;
  const u = result.rows[0];

  if (u.assigned_consultant_id) {
    return { consultantId: u.assigned_consultant_id, source: 'admin_assignment' };
  }
  if (u.acquisition_consultant_id) {
    return { consultantId: u.acquisition_consultant_id, source: 'member_signup' };
  }
  return fallback;
}

// Only consultants who are still active can be credited. A record that has
// been switched off is usually someone who has left, and quietly accruing
// commission to them is worse than crediting nobody.
async function isActiveConsultant(consultantId, client = pool) {
  if (!consultantId) return false;
  const r = await client.query('SELECT active FROM sales_consultants WHERE id = $1', [consultantId]);
  return r.rows.length > 0 && r.rows[0].active === true;
}

// What the two routes actually call: resolve, then drop the attribution if the
// chosen consultant is inactive or no longer exists.
async function attributeConsultant(userId, checkoutConsultantId, client = pool) {
  const resolved = await resolveConsultant(userId, checkoutConsultantId, client);
  if (!resolved.consultantId) return { consultantId: null, source: null };
  if (!(await isActiveConsultant(resolved.consultantId, client))) {
    return { consultantId: null, source: null };
  }
  return resolved;
}

module.exports = { resolveConsultant, isActiveConsultant, attributeConsultant };
