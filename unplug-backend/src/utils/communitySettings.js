// Members, Profile Social Interaction & Community System — Phase 8:
// whether each interaction type is currently switched on, in one place.
//
// Backed by the existing generic `settings` key/value table
// (008_settings_bundle_vote.sql) — an admin toggles these via the
// already-existing PATCH /admin/settings/:key, same as bundle_vote_price.
// No caching: these change rarely (an admin flipping a switch), and a
// stale in-process cache turned off mid-request would be a worse bug than
// one extra indexed lookup per action.

const pool = require('../db');

async function isCommunityFeatureEnabled(settingKey) {
  const result = await pool.query('SELECT value FROM settings WHERE key = $1', [settingKey]);
  // Missing row (e.g. a stage shipped after this migration, or a typo'd
  // key) fails OPEN, not closed — a config gap should never silently
  // block a feature nobody meant to disable.
  if (!result.rows.length) return true;
  return result.rows[0].value === 'true';
}

module.exports = { isCommunityFeatureEnabled };
