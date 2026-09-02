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

const BASE = ['approved', 'awaiting_payment', 'pending', 'rejected'];

test('EVERY SUBMISSION TABLE STILL CARRIES THE BASE VOCABULARY', () => {
  // The finding the task rests on: the submission model was already uniform.
  //
  // Phase B migrates services one at a time, so the tables legitimately differ
  // WHILE it runs — the gallery has three extra statuses, the rest do not yet.
  // What must never change is that all four original values are present
  // everywhere, because every existing row holds one of them and removing one
  // would fail the constraint on the next deploy.
  S.SUBMISSION_TABLES.forEach((t) => {
    const live = S.liveStatusesFor(t);
    BASE.forEach((v) => {
      assert.ok(live.includes(v), `${t} has lost the base status "${v}"`);
    });
  });
});

test('any status beyond the base is one we deliberately added', () => {
  // Catches a value creeping into a constraint without a decision behind it.
  const allowedExtras = ['draft', ...S.ALL.filter((s) => S.STATUSES[s].phase === 'B')];
  const unexpected = [];
  S.SUBMISSION_TABLES.forEach((t) => {
    S.liveStatusesFor(t).forEach((v) => {
      if (!BASE.includes(v) && !allowedExtras.includes(v)) unexpected.push(`${t}: ${v}`);
    });
  });
  assert.deepEqual(unexpected, []);
});

test('articles still carries draft, and only it does', () => {
  assert.ok(S.liveStatusesFor('articles').includes('draft'));
  S.SUBMISSION_TABLES.filter((t) => t !== 'articles').forEach((t) => {
    assert.equal(S.liveStatusesFor(t).includes('draft'), false,
      `${t} should not have draft — only articles support saving unsent work`);
  });
});

test('PHASE B1: THE GALLERY SERVICE HAS ITS NEW STATUSES', () => {
  // Both of the gallery's tables move together — a bundle and its images are
  // one submission, and letting them diverge would mean a bundle could be in a
  // state its own photos could not.
  ['gallery_bundles', 'gallery_images'].forEach((t) => {
    ['changes_requested', 'resubmitted', 'credit_issued'].forEach((v) => {
      assert.ok(S.isLiveFor(v, t), `${t} should accept ${v} after Phase B1`);
    });
  });
});

test('a gallery submission cannot expire, and is not pretending it can', () => {
  // A one-off purchase of photos that stay published has no term to run out.
  // Adding `expired` there would be a state nothing can reach.
  assert.equal(S.isLiveFor('expired', 'gallery_bundles'), false);
  assert.equal(S.STATUSES.expired.onlyFor, 'services that run for a fixed period');
});

// --------------------------------------------------------------- Phase B

test('PHASE B2: MARKETPLACE LISTINGS TOOK ALL FOUR, INCLUDING expired', () => {
  // A marketplace listing runs for a term — duration_days plus an active_to
  // date the public feed already checks — so `expired` is a state it can
  // genuinely reach. The gallery has no term, which is why it took three.
  ['changes_requested', 'resubmitted', 'credit_issued', 'expired'].forEach((v) => {
    assert.ok(S.isLiveFor(v, 'marketplace_listings'),
      `marketplace_listings should accept ${v} after Phase B2`);
  });
  assert.equal(S.isLiveFor('expired', 'gallery_bundles'), false,
    'the gallery still has no term to run out');
});

test('PHASE B3: EVENTS TOOK ALL FOUR, INCLUDING expired', () => {
  // An event finishes. The public feed already drops it once event_date has
  // passed, so `expired` is a state it genuinely reaches.
  ['changes_requested', 'resubmitted', 'credit_issued', 'expired'].forEach((v) => {
    assert.ok(S.isLiveFor(v, 'events'), `events should accept ${v} after Phase B3`);
  });
});

test('PHASE B4: HIGHLIGHTS TOOK ALL FOUR, INCLUDING expired', () => {
  // A highlight runs for a term — duration_days plus start_date/end_date, which
  // the member-facing list already turns into "Completed" by arithmetic.
  ['changes_requested', 'resubmitted', 'credit_issued', 'expired'].forEach((v) => {
    assert.ok(S.isLiveFor(v, 'highlights'), `highlights should accept ${v} after Phase B4`);
  });
});

test('EVERY HIGHLIGHT STATUS HAS A LABEL A MEMBER CAN READ', () => {
  // GET /highlights/mine ends its chain with `else label = 'Active'`, so a
  // status without a branch tells the member their highlight is running when it
  // is not. Read out of the route rather than duplicated here, so this fails
  // when a status is added and its label is forgotten.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'highlights.js'), 'utf8');
  const labelled = [...src.matchAll(/h\.status === '([a-z_]+)'/g)].map((m) => m[1]);
  const missing = S.liveStatusesFor('highlights')
    .filter((v) => v !== 'approved' && !labelled.includes(v));
  assert.deepEqual(missing, [],
    'these highlight statuses would fall through to "Active": ' + missing.join(', '));
});

test('PHASE B5: ARTICLES TOOK THREE, AND STILL CANNOT EXPIRE', () => {
  // The largest service on the board, and the last of Phase B. It takes the
  // three review statuses but not `expired`: an article has no duration and no
  // end date. scheduled_for holds one back UNTIL a date and then it stays.
  ['changes_requested', 'resubmitted', 'credit_issued'].forEach((v) => {
    assert.ok(S.isLiveFor(v, 'articles'), `articles should accept ${v} after Phase B5`);
  });
  assert.equal(S.isLiveFor('expired', 'articles'), false,
    'an article is published and stays published');
});

test('only the services that can run out have expired', () => {
  // The distinction the phases keep making, asserted rather than remembered:
  // a service gets `expired` only if something can actually end it.
  const withExpiry = S.SUBMISSION_TABLES.filter((t) => S.isLiveFor('expired', t)).sort();
  assert.deepEqual(withExpiry, ['events', 'highlights', 'marketplace_listings'],
    'expired should only be live where a term or a date ends the service');
});

test('every status is live on at least one service, or is honestly empty', () => {
  // Guards the thing the plan set out to avoid: a value declared everywhere
  // that nothing can ever set. Once a status is live somewhere it must stay
  // reachable; while it is live nowhere, notYetLive must say so.
  S.ALL.forEach((v) => {
    const live = S.STATUSES[v].live;
    if (live.length === 0) {
      assert.ok(S.notYetLive().includes(v), `${v} is live nowhere but not reported as pending`);
    }
  });
});

test('the Phase-B statuses are declared, and only the unreached ones are pending', () => {
  // Honesty check. These are named so the lifecycle is complete, but writing
  // one today would violate a CHECK and throw. The module must say so rather
  // than implying they work.
  // Phase B2 gave marketplace all four, so nothing is stranded any more: every
  // declared status is now reachable on at least one service.
  assert.deepEqual(S.notYetLive().sort(), []);

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

test('THE VOCABULARY IS NOW ACTUALLY USED', () => {
  // This started life as "NOTHING IMPORTS THIS YET", guarding Phase A: the
  // module was written to record what was already true, and importing it early
  // would have blurred writing-it-down with using-it. That test said it should
  // be replaced deliberately rather than quietly when the time came.
  //
  // The time came with the credit-on-rejection pathway. Declining a paid
  // submission now asks isLiveFor('credit_issued', table) instead of assuming,
  // because the status exists only on the services whose migration has landed
  // and writing it elsewhere would violate a CHECK.
  //
  // So the guard is inverted rather than deleted: the module must now HAVE a
  // consumer. A vocabulary nothing reads is documentation, and documentation
  // drifts from the database it describes.
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

  assert.ok(importers.includes('adminContent.js'),
    'the credit-on-rejection path should ask the vocabulary which status it may write');
});