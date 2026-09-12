const express = require('express');
const { requireRole } = require('../middleware/auth');
const G = require('../utils/agreementGenerator');

// Lightweight metadata router. The implementation is intentionally split into
// focused modules so syntax, permissions and release failures are isolated:
// - agreementGeneratorSetup.js
// - agreementGeneratorTemplateAdmin.js
// - agreementGeneratorRecordAdmin.js
// - agreementGeneratorSignerUpload.js
// - agreementGeneratorPartyB.js
const router = express.Router();

router.get('/generator/meta', requireRole('admin'), (req, res) => {
  res.json({
    masterSections: G.MASTER_SECTIONS,
    workflowStatuses: G.WORKFLOW_STATUSES,
    approvalStatuses: G.APPROVAL_STATUSES,
    partyBTypes: G.PARTY_B_TYPES,
    accessMethods: G.ACCESS_METHODS,
    signingOrders: G.SIGNING_ORDERS,
    signatureTypes: G.SIGNATURE_TYPES,
    noteUploadVisibility: ['internal_admin','party_b_visible','party_b_required'],
    signerRoles: ['primary','guardian','witness','authorised_representative','other'],
  });
});

module.exports = router;
