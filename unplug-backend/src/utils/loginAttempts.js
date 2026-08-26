// Brute-force protection for the account, not just for the address.
//
// The existing express-rate-limit keys on IP. That stops one machine trying
// ten thousand passwords; it does nothing about a hundred machines trying a
// hundred each, which is how password spraying actually works and is the
// cheaper attack to run.
//
// DELAY, DO NOT LOCK. A hard lockout — "five failures and the account is
// disabled" — is a denial of service anyone can trigger against anyone whose
// email address they know. This doubles the wait instead: 0s, 0s, 0s, then 5s,
// 10s, 20s, 40s and on to a cap of fifteen minutes. Three free attempts cover
// the person who genuinely mistyped. By the tenth, an attacker is getting one
// guess every quarter of an hour, which ends the exercise, and the real owner
// is never locked out — they wait a little, or reset their password, which
// this does not touch.
//
// THE FAILURE COUNT IS NOT A SECRET, BUT THE ACCOUNT'S EXISTENCE IS. Attempts
// are recorded against any address that was tried, whether or not it belongs
// to anyone, and the response says the same thing either way. Recording only
// real accounts would turn the delay itself into a way of asking "does this
// address have an account here?".

const pool = require('../db');

// Free attempts before any delay starts. Enough for a typo, a wrong saved
// password, and one more.
const FREE_ATTEMPTS = 3;

// The delay doubles from here.
const BASE_DELAY_SECONDS = 5;
const MAX_DELAY_SECONDS = 15 * 60;

// A quiet period after which the count resets on its own. Somebody who failed
// twice last week is not mid-attack today.
const RESET_AFTER_HOURS = 24;

const DISABLED = process.env.UNPLUG_DISABLE_RATE_LIMITS === '1';

function normalise(identifier) {
  return String(identifier || '').trim().toLowerCase().slice(0, 320);
}

// Seconds to wait before the next attempt, given how many have already failed.
function delayFor(failedCount) {
  const over = failedCount - FREE_ATTEMPTS;
  if (over <= 0) return 0;
  // 5, 10, 20, 40 ... capped. Math.min before the exponent would still
  // overflow at high counts, so the cap is applied to the result.
  const seconds = BASE_DELAY_SECONDS * Math.pow(2, over - 1);
  return Math.min(seconds, MAX_DELAY_SECONDS);
}

// May this identifier attempt a sign-in right now?
//
// Returns { allowed, retryAfterSeconds, failedCount }.
async function check(identifier) {
  if (DISABLED) return { allowed: true, retryAfterSeconds: 0, failedCount: 0 };
  const id = normalise(identifier);
  if (!id) return { allowed: true, retryAfterSeconds: 0, failedCount: 0 };

  const r = await pool.query(
    `SELECT failed_count, blocked_until, last_failed_at,
            GREATEST(0, CEIL(EXTRACT(EPOCH FROM (blocked_until - now()))))::int AS wait_seconds
       FROM login_attempts WHERE identifier = $1`, [id]);
  if (r.rowCount === 0) return { allowed: true, retryAfterSeconds: 0, failedCount: 0 };

  const row = r.rows[0];

  // A day of quiet wipes the slate. Checked here rather than by a scheduled
  // job so it is true the moment it becomes true, even if nothing has run.
  const ageHours = (Date.now() - new Date(row.last_failed_at).getTime()) / 3600000;
  if (ageHours >= RESET_AFTER_HOURS) {
    return { allowed: true, retryAfterSeconds: 0, failedCount: 0 };
  }

  if (row.blocked_until && row.wait_seconds > 0) {
    return { allowed: false, retryAfterSeconds: row.wait_seconds, failedCount: row.failed_count };
  }
  return { allowed: true, retryAfterSeconds: 0, failedCount: row.failed_count };
}

// Records a failure and returns the delay now in force.
async function recordFailure(identifier, ip) {
  if (DISABLED) return { failedCount: 0, retryAfterSeconds: 0 };
  const id = normalise(identifier);
  if (!id) return { failedCount: 0, retryAfterSeconds: 0 };
  const address = String(ip || '').slice(0, 64) || null;

  // One statement, so two simultaneous attempts cannot both read "2" and both
  // write "3". The count is computed in SQL from its own previous value.
  const r = await pool.query(
    `INSERT INTO login_attempts (identifier, failed_count, last_ip, distinct_ips, first_failed_at, last_failed_at, updated_at)
     VALUES ($1, 1, $2, 1, now(), now(), now())
     ON CONFLICT (identifier) DO UPDATE SET
       -- A day of quiet resets the count rather than compounding it.
       failed_count = CASE
         WHEN login_attempts.last_failed_at < now() - INTERVAL '${RESET_AFTER_HOURS} hours' THEN 1
         ELSE login_attempts.failed_count + 1 END,
       first_failed_at = CASE
         WHEN login_attempts.last_failed_at < now() - INTERVAL '${RESET_AFTER_HOURS} hours' THEN now()
         ELSE login_attempts.first_failed_at END,
       -- Counted only when the address CHANGES. One address failing over and
       -- over is a forgotten password; many addresses against one account is
       -- an attack, and this is what tells them apart.
       distinct_ips = login_attempts.distinct_ips
         + CASE WHEN login_attempts.last_ip IS DISTINCT FROM $2 THEN 1 ELSE 0 END,
       last_ip = $2,
       last_failed_at = now(),
       updated_at = now()
     RETURNING failed_count`,
    [id, address]);

  const failedCount = r.rows[0].failed_count;
  const seconds = delayFor(failedCount);

  if (seconds > 0) {
    await pool.query(
      `UPDATE login_attempts SET blocked_until = now() + ($2 || ' seconds')::interval
        WHERE identifier = $1`, [id, String(seconds)]);
  }
  return { failedCount, retryAfterSeconds: seconds };
}

// A successful sign-in clears the record: the failures were evidence of
// guessing only until the owner turned up.
async function recordSuccess(identifier) {
  if (DISABLED) return;
  const id = normalise(identifier);
  if (!id) return;
  await pool.query('DELETE FROM login_attempts WHERE identifier = $1', [id]);
}

// What is currently under attack — for the admin screen.
//
// Ordered by how many different addresses have tried, because that is the
// signal that separates a spraying attempt from somebody who cannot remember
// their password.
async function currentlyBlocked(limit = 50) {
  const r = await pool.query(
    `SELECT identifier, failed_count, distinct_ips, last_ip,
            first_failed_at, last_failed_at, blocked_until,
            (blocked_until IS NOT NULL AND blocked_until > now()) AS waiting
       FROM login_attempts
      WHERE last_failed_at > now() - INTERVAL '${RESET_AFTER_HOURS} hours'
      ORDER BY distinct_ips DESC, failed_count DESC
      LIMIT $1`, [limit]);
  return r.rows;
}

// Lets an admin clear a delay for somebody who is locked out and on the phone.
async function clear(identifier) {
  const id = normalise(identifier);
  if (!id) return false;
  const r = await pool.query('DELETE FROM login_attempts WHERE identifier = $1', [id]);
  return r.rowCount > 0;
}

module.exports = {
  check, recordFailure, recordSuccess, currentlyBlocked, clear, delayFor,
  FREE_ATTEMPTS, BASE_DELAY_SECONDS, MAX_DELAY_SECONDS, RESET_AFTER_HOURS,
};
