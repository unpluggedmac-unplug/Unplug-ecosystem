// Enforces Agreement Forms option C at the final signing boundary.
//
// The public definition can be read by anybody and free agreements can always
// be guest-signed. For a PAID agreement where admin selected "Unplug account
// required", however, the signature itself must also require a logged-in user.
// This closes both timings:
//   * after_sign — a guest cannot create a signed-but-unpayable record;
//   * before_sign — sharing a member's secret signingToken cannot turn a
//     member-only agreement into a guest signature.

const pool = require('../db');

module.exports = async function agreementPaymentPolicy(req, res, next) {
  if (req.method !== 'POST' || !/^\/[^/]+\/sign\/?$/.test(req.path)) return next();
  try {
    const slug = req.path.split('/')[1];
    const r = await pool.query(
      `SELECT amount, payment_mode, guest_payment_allowed
         FROM agreement_forms
        WHERE LOWER(slug) = LOWER($1)`,
      [slug]
    );
    if (!r.rowCount) return next(); // the real route owns the 404 response
    const agreement = r.rows[0];
    const isPaid = Number(agreement.amount) > 0 && agreement.payment_mode !== 'none';
    if (isPaid && !agreement.guest_payment_allowed && !req.user) {
      return res.status(401).json({
        error: 'This paid agreement requires an Unplug account before it can be signed.',
        accountRequired: true,
      });
    }
    return next();
  } catch (err) {
    return next(err);
  }
};
