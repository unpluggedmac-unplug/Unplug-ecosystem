// INV-002: the investment proposition (problem, market, revenue model,
// growth strategy) was flagged as a genuine gap this session — narrative
// content only the founders could really author. Written only after being
// explicitly asked to, and grounded entirely in what the platform actually
// is and already has built (the same real product lines and prices
// verified throughout this cycle, and the real participation/referral
// systems that already exist in the schema) rather than invented
// market-size or revenue-projection numbers nobody supplied.
//
// This test's job is narrow: confirm the five required sections exist and
// that the proposition names real product lines. Directory prices are no
// longer repeated here: admin-managed prices belong on the live Directory
// pricing surface, not in investor narrative copy that can drift.
//
// Website remediation punch-list (2026-09-03), INV-002.
//
// Run with:  npm test   (from unplug-backend/)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function readFrontend() {
  const file = path.join(__dirname, '..', '..', 'unplug-magazine.html');
  assert.ok(fs.existsSync(file), 'unplug-magazine.html should exist');
  return fs.readFileSync(file, 'utf8').split('\r\n').join('\n');
}

function readBackend(relPath) {
  const file = path.join(__dirname, '..', relPath);
  assert.ok(fs.existsSync(file), `${relPath} should exist`);
  return fs.readFileSync(file, 'utf8');
}

test('THE INVESTORS PAGE HAS ALL FIVE PROPOSITION SECTIONS, IN ORDER, BEFORE THE EVIDENCE DASHBOARD', () => {
  const src = readFrontend();
  const pageStart = src.indexOf('id="page-investors"');
  const dashboardIdx = src.indexOf('id="investorSnapshot"', pageStart);
  assert.ok(pageStart > -1 && dashboardIdx > -1);
  const block = src.slice(pageStart, dashboardIdx);

  const sections = ['The problem', 'What Unplug is', 'Market', 'Revenue model', 'Growth strategy'];
  let cursor = 0;
  sections.forEach((label) => {
    const idx = block.indexOf(`>${label}<`, cursor);
    assert.ok(idx > -1, `missing section: ${label}`);
    assert.ok(idx >= cursor, `${label} appears out of the expected pitch order`);
    cursor = idx;
  });
});

test('THE REVENUE MODEL DOES NOT DUPLICATE ADMIN-MANAGED DIRECTORY PRICES', () => {
  const src = readFrontend();
  const start = src.indexOf('Revenue model');
  const end = src.indexOf('Growth strategy', start);
  const block = src.slice(start, end);
  assert.match(block, /Directory packages — once-off packages/i);
  assert.doesNotMatch(block, /Directory packages[^\n<]*R\s*\d/i,
    'Directory prices can change in Admin, so investor copy must not freeze a second price list');
});

test('THE REVENUE MODEL NAMES ONLY REAL, ALREADY-BUILT PRODUCT LINES', () => {
  const src = readFrontend();
  const start = src.indexOf('Revenue model');
  const end = src.indexOf('Growth strategy', start);
  const block = src.slice(start, end);
  ['Directory packages', 'Competition entries', 'Advertising banners', 'Marketplace listings', 'Edition PDF downloads'].forEach((line) => {
    assert.match(block, new RegExp(line), `expected the real product line "${line}" to be listed`);
  });
});

test('NO FABRICATED QUANTITATIVE CLAIM APPEARS — NO MARKET SIZE, NO REVENUE PROJECTION, NO GROWTH PERCENTAGE', () => {
  const src = readFrontend();
  const start = src.indexOf('The opportunity');
  const end = src.indexOf('id="investorSnapshot"', start);
  const block = src.slice(start, end);
  // A number immediately followed by a scale word ("million", "billion",
  // "TAM", "%") is the shape a fabricated projection would take — no
  // source in this codebase supplied one, so none should appear here.
  assert.ok(!/\b\d+(\.\d+)?\s*(million|billion|TAM|SAM|SOM)\b/i.test(block),
    'no market-size figure was supplied by anyone — none should be invented');
  assert.ok(!/\bgrow(th|ing)?\s+(by\s+)?\d+%/i.test(block),
    'no real growth-rate projection was supplied — none should be invented');
});

test('THE GROWTH STRATEGY NAMES THE REAL, ALREADY-BUILT SYSTEMS BEHIND IT, NOT GENERIC STARTUP LANGUAGE ALONE', () => {
  const src = readFrontend();
  const start = src.indexOf('Growth strategy');
  const end = src.indexOf('INV-001', start);
  const block = src.slice(start, end);
  assert.match(block, /consultant referral network/i);
  assert.match(block, /commission tracking/i);
  assert.match(block, /badges, streaks/i);
});
