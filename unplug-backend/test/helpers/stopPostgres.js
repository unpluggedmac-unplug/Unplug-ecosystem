// Stopping an embedded Postgres cluster, for certain.
//
// THE BUG THIS EXISTS TO FIX. Every test file used to end with:
//
//     try { if (pg) await pg.stop(); } catch (e) { /* the OS is slow */ }
//
// and the comment was wrong about what goes wrong. embedded-postgres stops a
// cluster on Windows like this:
//
//     await new Promise((resolve) => {
//       this.process?.on('exit', resolve);
//       spawn('taskkill', ['/pid', pid, '/f', '/t']);   // fire and forget
//     });
//
// If that taskkill does not succeed, no 'exit' event ever arrives and the
// promise NEVER SETTLES. So `await pg.stop()` does not throw — it HANGS. The
// try/catch catches nothing, the after() hook never finishes, the test runner
// eventually tears the process down, and the cluster is left running with no
// parent.
//
// The evidence, from a machine that had been running these tests for a day:
// three postgres processes whose parent process no longer existed, and a
// pg_ctl still waiting on a stop that would never complete. Orphans accumulate
// across runs, hold their ports and their memory, and eventually a later test
// file cannot start its own cluster — which is why whole files would fail at
// setup, in a different file each run, while passing perfectly on their own.
//
// THE FIX: give stop() a deadline, and if it misses it, kill the process tree
// directly rather than waiting on an event that is not coming.

const { execFileSync } = require('child_process');
const fs = require('fs');

// Long enough for an honest shutdown of a small cluster, short enough that a
// hung stop does not hold up the suite. A healthy stop takes well under a
// second; anything past ten is not going to finish.
const STOP_TIMEOUT_MS = 10000;

function killTree(pid) {
  if (!pid) return false;
  try {
    if (process.platform === 'win32') {
      // /T for the children — a postmaster has several, and killing only the
      // parent leaves them holding the data directory.
      execFileSync('taskkill', ['/PID', String(pid), '/F', '/T'], { stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
    return true;
  } catch (err) {
    // Already gone is the common case and is a success, not a failure.
    return false;
  }
}

// Stops the cluster and removes its data directory. Never throws, never hangs.
//
// Returns 'stopped', 'killed' or 'failed', so a caller that cares can say
// which happened — mostly used to notice if the polite path stops working.
async function stopPostgres(pg, dataDir) {
  let outcome = 'stopped';

  if (pg) {
    // Captured BEFORE stop() runs: it sets this.process to undefined on the
    // way out, so afterwards there is nothing left to kill.
    const child = pg.process;
    const pid = child && child.pid;

    let timer;
    try {
      await Promise.race([
        pg.stop(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('pg.stop() did not finish')), STOP_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      // Either stop() threw, or it took too long. Both are handled the same
      // way: stop asking and end the process ourselves.
      outcome = killTree(pid) ? 'killed' : 'failed';
      if (outcome === 'failed') {
        console.warn(`[test] could not stop postgres (pid ${pid}): ${err.message}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  // stop() normally removes this itself, but not when it never got that far.
  if (dataDir) {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch (err) {
      // Windows can genuinely still hold a handle here for a moment after the
      // processes die. A leftover temp directory is untidy; it is not a
      // failure worth failing a test file for, and the OS clears it later.
    }
  }

  return outcome;
}

// Kills clusters left behind by earlier runs: postgres processes whose parent
// process no longer exists. Used before the suite starts, so a run never
// inherits yesterday's mess.
function sweepOrphans() {
  if (process.platform !== 'win32') return 0;
  let killed = 0;
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='postgres.exe'\" | "
      + 'ForEach-Object { "$($_.ProcessId),$($_.ParentProcessId)" }'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

    for (const line of out.split('\n')) {
      const [pid, parent] = line.trim().split(',').map(Number);
      if (!pid || !parent) continue;
      // Is the parent still alive? process.kill with signal 0 asks without
      // sending anything.
      let parentAlive = true;
      try { process.kill(parent, 0); } catch (e) { parentAlive = false; }
      if (!parentAlive && killTree(pid)) killed++;
    }
  } catch (err) {
    // The sweep is a courtesy. If it cannot run, the tests still do.
  }
  return killed;
}

module.exports = { stopPostgres, sweepOrphans, killTree, STOP_TIMEOUT_MS };
