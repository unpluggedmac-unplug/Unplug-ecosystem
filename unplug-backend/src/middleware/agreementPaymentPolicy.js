// Agreement Forms bridge.
//
// 1) The standalone Agreement Generator is deliberately mounted INSIDE the
//    existing /agreement-forms surface so the application keeps one Agreement
//    Forms backend and the legacy /agreements signed_agreements system remains
//    untouched.
// 2) Requests the generator does not handle fall through to the original
//    payment-policy guard and then to routes/agreementForms.js exactly as before.

const pool = require('../db');
const agreementGenerator = require('../routes/agreementGenerator');

async function enforcePaymentPolicy(req, res, next) {
  if (req.method !== 'POST' || !/^\/[^/]+\/sign\/?$/.test(req.path)) return next();
  try {
    const slug = req.path.split('/')[1];
    const r = await pool.query(
      `SELECT amount, payment_mode, guest_payment_allowed
         FROM agreement_forms
        WHERE LOWER(slug) = LOWER($1)`,
      [slug]
    );
    if (!r.rowCount) return next();
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
}

module.exports = function agreementFormsBridge(req, res, next) {
  // Express routers call the supplied callback only when no generator route
  // completed the request. That makes this a non-breaking extension: every old
  // Agreement Forms route continues into the original policy and router.
  agreementGenerator(req, res, (err) => {
    if (err) return next(err);
    return enforcePaymentPolicy(req, res, next);
  });
};
