// Proof-of-work bot defence. No database needed — this is hashes in, verdict
// out.
//
// The ways a proof-of-work check becomes decoration:
//
//   1. THE CHALLENGE IS NOT SIGNED, so a bot invents an easy one and solves
//      that. This is the failure that makes the whole thing pointless.
//   2. IT NEVER EXPIRES, so a bot solves a batch in advance and spends them.
//   3. IT IS TOO EXPENSIVE, and real people on old phones give up. That is not
//      a security failure but it is the one most likely to actually happen.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const altcha = require('../src/utils/altcha');

// Does what the browser widget does: try every number until the hash matches.
function solve(challenge) {
  for (let n = 0; n <= challenge.maxnumber; n++) {
    if (crypto.createHash('sha256').update(challenge.salt + n).digest('hex') === challenge.challenge) {
      return n;
    }
  }
  return null;
}

function solutionFor(challenge, number) {
  return {
    algorithm: 'SHA-256',
    challenge: challenge.challenge,
    number,
    salt: challenge.salt,
    signature: challenge.signature,
  };
}

test('A SOLVED CHALLENGE IS ACCEPTED', async () => {
  const c = altcha.createChallenge();
  const n = solve(c);
  assert.notEqual(n, null, 'the puzzle is actually solvable');
  assert.equal(altcha.verifySolution(solutionFor(c, n)).ok, true);
});

test('A CHALLENGE THE SERVER DID NOT ISSUE IS REFUSED', async () => {
  // The failure that makes proof-of-work decoration: a bot generating its own
  // trivial puzzle, solving it instantly, and submitting that.
  const forged = {
    algorithm: 'SHA-256',
    salt: `deadbeef.${Date.now() + 60000}`,
    maxnumber: 1,
  };
  forged.challenge = crypto.createHash('sha256').update(forged.salt + 0).digest('hex');
  forged.signature = 'f'.repeat(64); // not ours

  const result = altcha.verifySolution(solutionFor(forged, 0));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'signature');
});

test('the wrong answer is refused', async () => {
  const c = altcha.createChallenge();
  const n = solve(c);
  assert.equal(altcha.verifySolution(solutionFor(c, (n + 1) % c.maxnumber)).ok, false);
});

test('AN EXPIRED CHALLENGE IS REFUSED', async () => {
  // Otherwise a bot solves a thousand in advance and spends them at leisure.
  const c = altcha.createChallenge();
  const stale = { ...c, salt: `${c.salt.split('.')[0]}.${Date.now() - 1000}` };
  const result = altcha.verifySolution(solutionFor(stale, 0));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'expired');
});

test('the browser widget format is accepted', async () => {
  // The widget sends base64-encoded JSON rather than an object.
  const c = altcha.createChallenge();
  const n = solve(c);
  const encoded = Buffer.from(JSON.stringify(solutionFor(c, n))).toString('base64');
  assert.equal(altcha.verifySolution(encoded).ok, true);
});

test('rubbish is refused rather than throwing', async () => {
  for (const bad of [null, undefined, '', 'not-base64-or-json', '{}', 42, [], { number: 1 }]) {
    assert.doesNotThrow(() => altcha.verifySolution(bad));
    assert.equal(altcha.verifySolution(bad).ok, false);
  }
});

test('a number outside the range is refused without hashing it', async () => {
  const c = altcha.createChallenge();
  assert.equal(altcha.verifySolution(solutionFor(c, -1)).ok, false);
  assert.equal(altcha.verifySolution(solutionFor(c, altcha.MAX_NUMBER + 1)).ok, false);
  assert.equal(altcha.verifySolution(solutionFor(c, 1.5)).ok, false);
});

test('EVERY CHALLENGE IS DIFFERENT', async () => {
  // A repeated salt means a solution can be replayed against a later
  // challenge.
  const seen = new Set();
  for (let i = 0; i < 50; i++) seen.add(altcha.createChallenge().salt);
  assert.equal(seen.size, 50);
});

test('THE PUZZLE IS CHEAP ENOUGH FOR AN OLD PHONE', async () => {
  // The most likely real-world failure is not a bot getting through; it is a
  // reader on a cheap Android abandoning a form that takes seconds to submit.
  // This machine is far faster than that phone, so the budget here is
  // deliberately tight.
  const c = altcha.createChallenge();
  const started = Date.now();
  solve(c);
  const ms = Date.now() - started;
  assert.ok(ms < 1500, `solving took ${ms}ms here; a slow phone is several times that`);
});

test('verifying costs one hash, however hard the puzzle was', async () => {
  // The asymmetry is the entire mechanism: expensive to solve, trivial to
  // check, so volume costs the sender and not us.
  const c = altcha.createChallenge();
  const n = solve(c);
  const started = Date.now();
  for (let i = 0; i < 100; i++) altcha.verifySolution(solutionFor(c, n));
  assert.ok(Date.now() - started < 500, 'a hundred verifications are effectively free');
});
