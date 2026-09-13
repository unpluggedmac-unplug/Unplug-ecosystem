const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { IMAGE_SPECS, describe } = require('../utils/imageSpecs');
const pool = require('../db');
const { loadAdSlotSizes, describeSlot } = require('../utils/adSlotFormats');

const router = express.Router();

// GET /image-specs — the recommended size for every image field.
//
// Behind a login on purpose. This is guidance for people filling in a
// submission form, not something a reader ever needs, and the ask was for it
// to show in the dashboards without appearing anywhere on the public site.
//
// One request, all of it: the dashboards fetch it once at load and then have
// every field's size, rather than a round trip per field.
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const specs = {};
    Object.entries(IMAGE_SPECS).forEach(([k, s]) => {
      specs[k] = { w: s.w, h: s.h, label: s.label, note: s.note || null, text: describe(s) };
    });
    // Resolved, not the raw defaults: if an admin has changed a slot's format,
    // the person uploading a banner for it must be told the size it will
    // actually render at, not the size it used to be.
    const resolved = await loadAdSlotSizes(pool);
    const adSlots = {};
    Object.entries(resolved).forEach(([k, s]) => {
      adSlots[k] = {
        w: s.w, h: s.h, label: s.label, fit: s.fit,
        customised: s.customised, text: describeSlot(s),
      };
    });
    res.json({ specs, adSlots });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
