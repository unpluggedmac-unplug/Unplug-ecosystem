#!/usr/bin/env node
//
// Kills embedded-postgres clusters left behind by earlier test runs.
//
// Runs automatically before `npm test` (see the "pretest" script). A run should
// never inherit the previous one's mess: an orphaned cluster holds a port, a
// data directory and a few hundred megabytes, and enough of them stop a later
// test file from starting its own — which shows up as an entire file failing
// at setup, in a different file each time, while passing perfectly alone.
//
// Only clusters whose PARENT PROCESS NO LONGER EXISTS are killed. A test run
// happening right now in another window has a live parent and is left alone.

const { sweepOrphans } = require('../test/helpers/stopPostgres');

const killed = sweepOrphans();
if (killed > 0) {
  console.log(`[sweep] ended ${killed} orphaned postgres process(es) from an earlier run`);
}
