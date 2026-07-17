const express = require('express');
const pool = require('../db');

const router = express.Router();

// Only these settings are safe to expose to the public frontend.
const PUBLIC_KEYS = ['youtube_image_url'];

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
