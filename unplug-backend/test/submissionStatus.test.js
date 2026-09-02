// The submission lifecycle, checked against the database it describes.
//
// src/utils/submissionStatus.js writes down a vocabulary that nine tables
// already share. A written-down copy of a value that lives somewhere else is
// exactly this codebase's recurring bug — image sizes, ad sizes and prices have
// all drifted that way — so the test that matters here is not "does the module
// parse". It is:
//
//   EVERY STATUS THE MIGRATIONS ALLOW IS DECLARED, AND EVERY STATUS DECLARED
//   AS LIVE IS ONE THE MIGRATIONS ACTUALLY ALLOW.
//
// That is checked by reading the migrations themselves, in order, the same way
// Postgres does — because each table's CREATE TABLE only tells you what the
// vocabulary USED to be, and 36 later migrations extend those constraints.
//
// No database needed: this is file parsing plus the module.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const S = require('../src/utils/submissionStatus');

// ---------------------------------------------------------------------------
// Work out what the database ACTUALLY allows, by replaying the migrations.
// ---------------------------------------------------------------------------
function effectiveStatusConstraints() {
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const effective = {};

  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8').replace(/\s+/g, ' ');

    // status CHECK written inline in a CREATE TABLE
    const created = sql.matchAll(
      /CREATE TABLE IF NOT EXISTS (\w+)(.*?)(?=CREATE TABLE IF NOT EXISTS |$)/gi
    );
    for (const m of created) {
      const inner = m[2];
      const chk = inner.match(/status[^,]*?CHECK \(\s*status IN \(([^)]*)\)/i);
      if (chk) effective[m[1]] = parseList(chk[1]);
    }

    // a later ALTER TABLE … ADD CONSTRAINT … CHECK (status IN (…))
    const altered = sql.matchAll(
      /ALTER TABLE (\w+) ADD CONSTRAINT \w*status\w* CHECK \(\s*status IN \(([^)]*)\)/gi
    );
    for (const m of altered) effective[m[1]] = parseList(m[2]);
  }
  return effective;
}

function parseList(raw) {
  return raw.split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean);
}

const DB = effectiveStatusConstraints();

// ---------------------------------------------------------------------------

test('THE MODULE AND THE MIGRATIONS AGREE, IN BOTH DIRECTIONS', () => {
  // The whole point of the file. If someone adds a status to a migration and
  // not to the module, or the other way round, this fails and names the table.
  const problems = [];

  for (const table of S.SUBMISSION_TABLES) {
    const allowed = DB[table];
    assert.ok(allowed, `no status constraint found for ${table} — has it been renamed?`);

    const declared = S.liveStatusesFor(table).sort();
    const actual = allowed.slice().sort();

    actual.forEach((v) => {
      if (!declared.includes(v)) {
        problems.push(`${table}: database allows "${v}" but the module does not declare it live`);
      }
    });
    declared.forEach((v) => {
      if (!actual.includes(v)) {
        problems.push(`${table}: module declares "${v}" live but the database rejects it`);
      }
    });
  }

  assert.deepEqual(problems, [], 'module and migrations disagree:\n  ' + problems.join('\n  '));
});

test('the eight non-article tables share exactly one vocabulary', () => {
  // This is the finding the whole task rests on: the submission model is not
  // fragmented, it is already uniform. If that stops being true, the plan in
  // docs/spine-plan.md needs revisiting, so it is asserted rather than assumed.
  const others = S.SUBMISSION_TABLES.filter((t) => t !== 'articles');
  const shape = JSON.stringify(S.liveStatusesFor(others[0]).sort());
  others.forEach((t) => {
    assert.equal(JSON.stringify(S.liveStatusesFor(t).sort()), shape,
      `${t} has drifted from the shared submission vocabulary`);
  });
  assert.deepEqual(JSON.parse(shape),
    ['approved', 'awaiting_payment', 'pending', 'rejected']);
});

test('articles is the shared vocabulary plus draft, and nothing else', () => {
  const articles = S.liveStatusesFor('articles').sort();
  assert.deepEqual(articles,
    ['approved', 'awaiting_payment', 'draft', 'pending', 'rejected']);
});

// --------------------------------------------------------------- Phase B

test('THE FOUR PHASE-B STATUSES ARE DECLARED BUT NOT YET LIVE', () => {
  // Honesty check. These are named so the lifecycle is complete, but writing
  // one today would violate a CHECK and throw. The module must say so rather
  // than implying they work.
  assert.deepEqual(S.notYetLive().sort(),
    ['changes_requested', 'credit_issued', 'expired', 'resubmitted']);

  S.notYetLive().forEach((s) => {
    S.SUBMISSION_TABLES.forEach((t) => {
      assert.equal(S.isLiveFor(s, t), false, `${s} must not be claimed live on ${t} yet`);
    });
  });
});

test('every Phase-B status says which phase adds it', () => {
  S.notYetLive().forEach((s) => {
    assert.equal(S.STATUSES[s].phase, 'B', `${s} has no phase recorded`);
  });
});

// ------------------------------------------------------------ the lifecycle

test('every status has a meaning and a place in the lifecycle', () => {
  S.ALL.forEach((s) => {
    assert.ok(S.STATUSES[s].meaning, `${s} has no explanation`);
    assert.ok(Array.isArray(S.TRANSITIONS[s]), `${s} is missing from TRANSITIONS`);
  });
});

test('no transition points at a status that does not exist', () => {
  // A typo here would be invisible until something tried to follow it.
  const bad = [];
  Object.entries(S.TRANSITIONS).forEach(([from, tos]) => {
    tos.forEach((to) => { if (!S.isKnown(to)) bad.push(`${from} -> ${to}`); });
  });
  assert.deepEqual(bad, []);
});

test('the ordinary path runs from submitted to decided', () => {
  assert.ok(S.canTransition('awaiting_payment', 'pending'));
  assert.ok(S.canTransition('pending', 'approved'));
  assert.ok(S.canTransition('pending', 'changes_requested'));
  assert.ok(S.canTransition('changes_requested', 'resubmitted'));
  assert.ok(S.canTransition('resubmitted', 'approved'));
  assert.ok(S.canTransition('rejected', 'credit_issued'));

  // And does not run backwards or skip the queue.
  assert.equal(S.canTransition('approved', 'pending'), false);
  assert.equal(S.canTransition('awaiting_payment', 'approved'), false,
    'nothing is approved before the money arrives');
});

test('credit_issued and expired are where a submission stops', () => {
  assert.deepEqual(S.TRANSITIONS.credit_issued, []);
  assert.deepEqual(S.TRANSITIONS.expired, []);
});

test('an unknown status is answered, not thrown at', () => {
  assert.equal(S.isKnown('APPROVED'), false, 'casing matters; the code is lowercase');
  assert.equal(S.canTransition('nonsense', 'pending'), false);
  assert.equal(S.isLiveFor('nonsense', 'articles'), false);
});

test('NOTHING IMPORTS THIS YET', () => {
  // Phase A writes the vocabulary down; Phase B starts using it. If something
  // has begun importing it, the phases have blurred and this test should be
  // deleted deliberately rather than quietly.
  const srcDir = path.join(__dirname, '..', 'src');
  const importers = [];
  (function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return walk(p);
      if (!e.name.endsWith('.js') || e.name === 'submissionStatus.js') return;
      if (fs.readFileSync(p, 'utf8').includes('submissionStatus')) importers.push(e.name);
    });
  }(srcDir));
  assert.deepEqual(importers, [],
    'Phase A is meant to change no behaviour; these files already use it: ' + importers.join(', '));
});
