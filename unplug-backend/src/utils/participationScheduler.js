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

async function rotateWeeklyMission() {
  await pool.query('SELECT rotate_weekly_mission()');
}

async function syncBusinessStatuses() {
  await pool.query('SELECT sync_all_business_statuses()');
}

async function rotateMonthlyChallenge() {
  await pool.query('SELECT rotate_monthly_challenge()');
}

// Freeze the Top 10 for the month that has just ended. Returns quietly once
// that month is already in top10_monthly_captures, so this is a no-op for all
// but the first run after a month turns over.
async function captureTop10Month() {
  const { runDueCapture } = require('./top10MonthlyCapture');
  return runDueCapture();
}

const RANKINGS_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours
const HOMEPAGE_INTERVAL_MS = 60 * 60 * 1000; // hourly — cheap to re-run, and picks up a new day promptly even if the instance was asleep at midnight
const WEEKLY_MISSION_INTERVAL_MS = 60 * 60 * 1000; // hourly — rotate_weekly_mission() is a no-op once this week's pick exists, so this just catches the Monday boundary promptly even through sleep/restarts
const BUSINESS_STATUS_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily — the only promotions this catches that review/gallery approval don't are tenure-based (min_days_listed), which only ever changes once a day
const MONTHLY_CHALLENGE_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily — rotate_monthly_challenge() is a no-op once this month's pick exists, so this just catches the 1st-of-month boundary promptly through sleep/restarts
// Hourly, not "at 23:59 on the last day". The instance sleeps when idle, so a
// job pinned to one minute of the month would simply be missed. It does not
// need that minute: every vote carries the month it belongs to, so the board
// for a closed month is fixed and computes identically whenever this runs.
// Hourly just means the capture lands soon after the month turns, and the
// captures table makes every run after the first a no-op.
const TOP10_CAPTURE_INTERVAL_MS = 60 * 60 * 1000;

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

  setInterval(() => {
    rotateWeeklyMission()
      .then(() => console.log('[participation] weekly mission check done'))
      .catch((err) => console.error('[participation] weekly mission rotation failed:', err.message));
  }, WEEKLY_MISSION_INTERVAL_MS);

  setInterval(() => {
    syncBusinessStatuses()
      .then(() => console.log('[participation] business statuses synced'))
      .catch((err) => console.error('[participation] business status sync failed:', err.message));
  }, BUSINESS_STATUS_INTERVAL_MS);

  setInterval(() => {
    rotateMonthlyChallenge()
      .then(() => console.log('[participation] monthly challenge check done'))
      .catch((err) => console.error('[participation] monthly challenge rotation failed:', err.message));
  }, MONTHLY_CHALLENGE_INTERVAL_MS);

  setInterval(() => {
    captureTop10Month()
      .then((r) => { if (r && r.captured) console.log(`[top10] captured ${r.month}/${r.year}: ${r.entryCount} entries, ${r.awardedBadges.length} badges`); })
      .catch((err) => console.error('[top10] monthly capture failed:', err.message));
  }, TOP10_CAPTURE_INTERVAL_MS);

  // Run once shortly after boot too, same reasoning as the birthday
  // check: a restart during the day shouldn't mean stale rankings until
  // the next scheduled mark.
  setTimeout(() => {
    recalculateRankings()
      .then(() => console.log('[participation] startup rankings recalculation done'))
      .catch((err) => console.error('[participation] startup rankings recalculation failed:', err.message));
    refreshDailyHomepage()
      .then(() => console.log('[participation] startup daily homepage refresh done'))
      .catch((err) => console.error('[participation] startup daily homepage refresh failed:', err.message));
    rotateWeeklyMission()
      .then(() => console.log('[participation] startup weekly mission check done'))
      .catch((err) => console.error('[participation] startup weekly mission rotation failed:', err.message));
    syncBusinessStatuses()
      .then(() => console.log('[participation] startup business status sync done'))
      .catch((err) => console.error('[participation] startup business status sync failed:', err.message));
    rotateMonthlyChallenge()
      .then(() => console.log('[participation] startup monthly challenge check done'))
      .catch((err) => console.error('[participation] startup monthly challenge rotation failed:', err.message));
    // This one matters most on a sleeping instance: the wake after a month
    // turns over may well BE the boot, and the month should close then rather
    // than up to an hour later.
    captureTop10Month()
      .then((r) => console.log('[top10] startup monthly capture check done'
        + (r && r.captured ? ` — captured ${r.month}/${r.year}` : '')))
      .catch((err) => console.error('[top10] startup monthly capture failed:', err.message));
  }, 25000);
}

module.exports = { start, recalculateRankings, refreshDailyHomepage, rotateWeeklyMission, syncBusinessStatuses, rotateMonthlyChallenge, captureTop10Month };
