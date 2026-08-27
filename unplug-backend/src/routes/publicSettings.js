const express = require('express');
const pool = require('../db');

const router = express.Router();

// Only these settings are safe to expose to the public frontend.
// unlisted_pages is here because the PUBLIC SITE is what has to act on it:
// the magazine hides those entries from its own menus. Exposing it reveals
// nothing — an unlisted page is fully public to anybody with the link, and it
// stays in the sitemap. This is decluttering, never privacy, and nothing that
// actually needs protecting should ever rely on it.
const PUBLIC_KEYS = [
  'youtube_image_url',
  'unlisted_pages',
  // The assistant's "talk to a person" handoff. A business WhatsApp number
  // that is already printed on a card is not a secret, and the page cannot
  // offer the button without knowing it.
  'whatsapp_number',
  'whatsapp_hours',
];

// GET /public-settings — returns a whitelisted subset of settings for the
// public site (e.g. the admin-chosen YouTube section image).
router.get('/', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT key, value FROM settings WHERE key = ANY($1)`,
      [PUBLIC_KEYS]
    );
    const settings = {};
    result.rows.forEach((r) => { settings[r.key] = r.value; });
    res.json({ settings });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
