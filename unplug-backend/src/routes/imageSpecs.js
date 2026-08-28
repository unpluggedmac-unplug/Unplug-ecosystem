const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { IMAGE_SPECS, AD_SLOT_SIZES, describe } = require('../utils/imageSpecs');

const router = express.Router();

// GET /image-specs — the recommended size for every image field.
//
// Behind a login on purpose. This is guidance for people filling in a
// submission form, not something a reader ever needs, and the ask was for it
// to show in the dashboards without appearing anywhere on the public site.
//
// One request, all of it: the dashboards fetch it once at load and then have
// every field's size, rather than a round trip per field.
router.get('/', requireAuth, (req, res) => {
  const specs = {};
  Object.entries(IMAGE_SPECS).forEach(([k, s]) => {
    specs[k] = { w: s.w, h: s.h, label: s.label, note: s.note || null, text: describe(s) };
  });
  const adSlots = {};
  Object.entries(AD_SLOT_SIZES).forEach(([k, s]) => {
    adSlots[k] = { w: s.w, h: s.h, label: s.label, text: `${s.w} × ${s.h}px (${s.label})` };
  });
  res.json({ specs, adSlots });
});

module.exports = router;
