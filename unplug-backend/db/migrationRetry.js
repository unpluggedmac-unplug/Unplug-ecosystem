'use strict';

// Retry policy for migration execution.
//
// PostgreSQL explicitly marks deadlocks (40P01) and serialization failures
// (40001) as concurrency conditions whose transaction should be retried.
// Nothing else belongs here: a migration with bad SQL must still stop a deploy.
const RETRYABLE_MIGRATION_CODES = new Set(['40P01', '40001']);
const DEFAULT_RETRY_MS = [250, 750, 1500];
const DEFAULT_MAX_ATTEMPTS = DEFAULT_RETRY_MS.length + 1;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWithMigrationRetry({
  file,
  operation,
  sleep = delay,
  retryMs = DEFAULT_RETRY_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  onRetry = () => {},
}) {
  if (typeof operation !== 'function') throw new TypeError('operation must be a function');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError('maxAttempts must be a positive integer');
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (err) {
      const retryable = RETRYABLE_MIGRATION_CODES.has(err && err.code);
      if (!retryable || attempt === maxAttempts) throw err;

      const waitMs = Number(retryMs[Math.min(attempt - 1, retryMs.length - 1)] || 0);
      onRetry({
        file,
        code: err.code,
        attempt,
        nextAttempt: attempt + 1,
        maxAttempts,
        waitMs,
      });
      if (waitMs > 0) await sleep(waitMs);
    }
  }

  throw new Error('Migration retry loop ended unexpectedly.');
}

module.exports = {
  RETRYABLE_MIGRATION_CODES,
  DEFAULT_RETRY_MS,
  DEFAULT_MAX_ATTEMPTS,
  runWithMigrationRetry,
};
