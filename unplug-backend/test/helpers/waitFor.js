// Wait for something a route did NOT await.
//
// WHY THIS EXISTS. Several routes deliberately fire work and return without
// waiting for it — the audit-log write, the redirect hit counter, clearing the
// brute-force record after a good sign-in, the marketing event. That is the
// right shape for production: a reader must never wait on bookkeeping, and a
// failed audit write must never fail the action it describes.
//
// It is an awkward shape to TEST, and the obvious way to handle it is wrong:
//
//     await new Promise((r) => setTimeout(r, 120));   // let it settle
//     assert.ok(row, 'the entry exists');
//
// That fixed sleep was a real intermittent failure. 120ms is generous on an
// idle machine and not enough when the rest of the suite is competing for the
// same CPU and disk, so two tests in activityLogSearch failed together perhaps
// one run in three and passed every time they were run alone. It was
// reproduced deterministically by shrinking the sleep to zero.
//
// Polling fixes it in both directions: it returns as soon as the thing is
// true — usually a few milliseconds, faster than the sleep it replaced — and
// it keeps waiting under load instead of giving up at an arbitrary moment.
//
// A NOTE ON WHAT THIS CANNOT DO. Waiting for something to APPEAR is sound.
// Waiting to prove something will NEVER appear is not: no amount of polling
// establishes that. For those, assert on a state the code does reach — or
// await the work directly.

const DEFAULT_TIMEOUT_MS = 10000;
const POLL_INTERVAL_MS = 20;

// Resolves with the first truthy value `check()` returns. Throws a message
// naming what was being waited for, rather than leaving the caller with an
// assertion failure or a TypeError that says nothing about the real cause.
async function waitFor(check, what = 'the expected state', timeoutMs = DEFAULT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
      lastError = null;
    } catch (err) {
      // A check that throws while the world is still settling is not a
      // failure yet — a row may not exist for a join to reach. Keep the error
      // so the timeout message can explain what kept going wrong.
      lastError = err;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for ${what}`
        + (lastError ? ` — last error: ${lastError.message}` : '')
      );
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

module.exports = { waitFor, DEFAULT_TIMEOUT_MS };
