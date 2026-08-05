// Drives the participation engine's periodic recalculations without
// pg_cron — this project runs on Render's own Postgres, not Supabase, so
// there's no database-level job scheduler available. Same pattern as
// src/utils/birthdayMailer.js: an in-process interval started from
// app.js. Each job is idempotent (safe to run again if it overlaps a
// restart) and failures are logged, never thrown, so one bad run can't
// take the server down.

const pool = require('../db');

async function recalculateRankings() {
  await pool.query('SELECT recalculate_all_rankings()');
}

async function refreshDailyHomepage() {
  await pool.query('SELECT calculate_daily_homepage()');
}

const RANKINGS_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours
const HOMEPAGE_INTERVAL_MS = 60 * 60 * 1000; // hourly — cheap to re-run, and picks up a new day promptly even if the instance was asleep at midnight

function start() {
  setInterval(() => {
    recalculateRankings()
      .then(() => console.log('[participation] rankings recalculated'))
      .catch((err) => console.error('[participation] rankings recalculation failed:', err.message));
  }, RANKINGS_INTERVAL_MS);

  setInterval(() => {
    refreshDailyHomepage()
      .then(() => console.log('[participation] daily homepage refreshed'))
      .catch((err) => console.error('[participation] daily homepage refresh failed:', err.message));
  }, HOMEPAGE_INTERVAL_MS);

  // Run once shortly after boot too, same reasoning as the birthday
  // check: a restart during the day shouldn't mean stale rankings until
  // the next 6-hour mark.
  setTimeout(() => {
    recalculateRankings()
      .then(() => console.log('[participation] startup rankings recalculation done'))
      .catch((err) => console.error('[participation] startup rankings recalculation failed:', err.message));
    refreshDailyHomepage()
      .then(() => console.log('[participation] startup daily homepage refresh done'))
      .catch((err) => console.error('[participation] startup daily homepage refresh failed:', err.message));
  }, 25000);
}

module.exports = { start, recalculateRankings, refreshDailyHomepage };
