// Agreement Forms bridge.
//
// The standalone Agreement Generator is mounted INSIDE the existing
// /agreement-forms surface. Requests not handled by the generator continue to
// the original Agreement Forms routes and payment policy. The legacy
// /agreements signed_agreements system remains separate and untouched.

const pool = require('../db');
const agreementGeneratorSetup = require('../routes/agreementGeneratorSetup');
const agreementGenerator = require('../routes/agreementGenerator');
const agreementGeneratorTemplateAdmin = require('../routes/agreementGeneratorTemplateAdmin');
const agreementGeneratorRecordAdmin = require('../routes/agreementGeneratorRecordAdmin');
const agreementGeneratorSignerUpload = require('../routes/agreementGeneratorSignerUpload');
const agreementGeneratorPartyB = require('../routes/agreementGeneratorPartyB');

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
  agreementGeneratorSetup(req, res, (setupErr) => {
    if (setupErr) return next(setupErr);
    agreementGenerator(req, res, (metaErr) => {
      if (metaErr) return next(metaErr);
      agreementGeneratorTemplateAdmin(req, res, (templateErr) => {
        if (templateErr) return next(templateErr);
        agreementGeneratorRecordAdmin(req, res, (recordErr) => {
          if (recordErr) return next(recordErr);
          agreementGeneratorSignerUpload(req, res, (uploadErr) => {
            if (uploadErr) return next(uploadErr);
            agreementGeneratorPartyB(req, res, (partyBErr) => {
              if (partyBErr) return next(partyBErr);
              return enforcePaymentPolicy(req, res, next);
            });
          });
        });
      });
    });
  });
};
