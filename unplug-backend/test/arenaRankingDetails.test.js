// ARENA-001: The Arena's entries showed a vote count but no explicit rank —
// a reader had to count grid position to work out anyone's placing — and
// the page had no way to say what the prize is, who's eligible, what the
// rules are, or how a winner gets chosen. None of that content existed
// anywhere in the system (confirmed by grep before writing anything), so
// this is a real gap, not a documentation one — but it's genuine editorial
// content the publisher has to supply, not something to invent. New
// prize/rules/eligibility/winner_process columns (migration 172) are shown
// on the public page only once actually filled in.
//
// Website remediation punch-list (2026-09-03), ARENA-001.
//
// Run with:  npm test   (from unplug-backend/)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', '..', 'unplug-magazine.html');

function read() {
  assert.ok(fs.existsSync(FILE), 'unplug-magazine.html should exist');
  return fs.readFileSync(FILE, 'utf8').split('\r\n').join('\n');
}

test('EACH ENTRY CARD SHOWS AN EXPLICIT RANK NUMBER, DERIVED FROM THE SAME SORT ORDER IT IS RENDERED IN', () => {
  const src = read();
  const fnIdx = src.indexOf('function arenaEntryCardHtml(entry, rank)');
  assert.ok(fnIdx > -1);
  const body = src.slice(fnIdx, fnIdx + 300);
  assert.match(body, /#\$\{rank\}/);

  const callIdx = src.indexOf('.map((e, i) => arenaEntryCardHtml(e, i + 1))');
  assert.ok(callIdx > -1, 'the rank passed in must be the 1-based position in the vote-sorted list, not a separate guess');
  // The sort must happen BEFORE the rank is assigned, in the same expression.
  const before = src.slice(Math.max(0, callIdx - 120), callIdx);
  assert.match(before, /sort\(\(a, b\) => b\.vote_count - a\.vote_count\)/);
});

test('PRIZE/ELIGIBILITY/RULES/WINNER-PROCESS ARE ONLY RENDERED WHEN THE COMPETITION ACTUALLY HAS THEM SET', () => {
  const src = read();
  const idx = src.indexOf("const detail = (label, text) => text ?");
  assert.ok(idx > -1, 'the detail renderer must return nothing for an unset field, not a placeholder');
  const block = src.slice(idx, idx + 500);
  assert.match(block, /data\.competition\.prize/);
  assert.match(block, /data\.competition\.eligibility/);
  assert.match(block, /data\.competition\.rules/);
  assert.match(block, /data\.competition\.winner_process/);
});

test('THE DETAILS BLOCK ITSELF IS OMITTED ENTIRELY WHEN NOTHING IS SET, NOT SHOWN AS AN EMPTY SECTION', () => {
  const src = read();
  const idx = src.indexOf('${details ? `<div class="comp-details">');
  assert.ok(idx > -1);
});
