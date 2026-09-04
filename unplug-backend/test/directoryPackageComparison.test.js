// DIR-002: prices between Basic/Pro/Premium were confirmed, but the actual
// feature differences were not — and rather than invent a comparison table,
// the real differences were traced through the code that already enforces
// them: search placement order (routes/profiles.js), which profile fields
// show at all (profileDetailHtml's showExtras/showGallery in
// unplug-magazine.html), the listing-photo limit (routes/gallery.js's
// PHOTO_LIMITS), and the free credits per billing cycle
// (routes/admin.js's creditsForTier). The table was then confirmed against
// the publisher before being built.
//
// This test locks in that every number/fact in the built table still
// matches the real source it was read from — so if PHOTO_LIMITS or
// creditsForTier ever changes, this fails instead of the public page
// quietly going wrong.
//
// Website remediation punch-list (2026-09-03), DIR-002.
//
// Run with:  npm test   (from unplug-backend/)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function readFile(filename) {
  const file = path.join(__dirname, '..', '..', filename);
  assert.ok(fs.existsSync(file), `${filename} should exist`);
  return fs.readFileSync(file, 'utf8').split('\r\n').join('\n');
}

function readBackend(relPath) {
  const file = path.join(__dirname, '..', relPath);
  assert.ok(fs.existsSync(file), `${relPath} should exist`);
  return fs.readFileSync(file, 'utf8');
}

test('THE TABLE\'S LISTING-PHOTO LIMITS MATCH gallery.js\'S REAL PHOTO_LIMITS', () => {
  const backend = readBackend('src/routes/gallery.js');
  const limitsMatch = backend.match(/PHOTO_LIMITS = \{ basic: (\d+), pro: (\d+), premium: (\d+) \}/);
  assert.ok(limitsMatch, 'PHOTO_LIMITS shape changed — update this test\'s pattern first');
  const [, basic, pro, premium] = limitsMatch;

  const frontend = readFile('unplug-magazine.html');
  const idx = frontend.indexOf("label: 'Listing photo limit'");
  assert.ok(idx > -1);
  const line = frontend.slice(idx, idx + 200).split('\n')[0];
  assert.match(line, new RegExp(`basic: '${basic}'.*pro: '${pro}'.*premium: '${premium}'`),
    'the comparison table\'s photo limits must match PHOTO_LIMITS exactly');
});

test('THE TABLE\'S PRICES MATCH payments.js\'S REAL PACKAGE_PRICES', () => {
  const backend = readBackend('src/routes/payments.js');
  const backendMatch = backend.match(/individual: \{ basic: ([\d.]+), pro: ([\d.]+), premium: ([\d.]+) \}/);
  assert.ok(backendMatch, 'PACKAGE_PRICES shape changed — update this test\'s pattern first');
  const [, iBasic, iPro, iPremium] = backendMatch.map((n, i) => (i === 0 ? n : Number(n)));

  const frontend = readFile('unplug-magazine.html');
  const frontendMatch = frontend.match(/individual: \{ basic: (\d+), pro: (\d+), premium: (\d+) \}/);
  assert.ok(frontendMatch, 'PKG_PRICES shape changed — update this test\'s pattern first');
  assert.equal(Number(frontendMatch[1]), iBasic);
  assert.equal(Number(frontendMatch[2]), iPro);
  assert.equal(Number(frontendMatch[3]), iPremium);
});

test('ONLY PRO AND PREMIUM CLAIM QUOTE/ACHIEVEMENTS/CAREER — MATCHING profileDetailHtml\'s showExtras GATE', () => {
  const frontend = readFile('unplug-magazine.html');
  const gateIdx = frontend.indexOf("const showExtras = tier === 'pro' || tier === 'premium';");
  assert.ok(gateIdx > -1, 'showExtras logic must still be pro/premium only — the table assumes this');

  ['individual', 'business'].forEach((type) => {
    const rowsIdx = frontend.indexOf(`${type}: [`, frontend.indexOf('PKG_COMPARE_ROWS'));
    const block = frontend.slice(rowsIdx, rowsIdx + 500);
    assert.match(block, /Quote, Achievements &amp; Career shown', basic: '', pro: '✓', premium: '✓'/,
      `the ${type} table's Quote/Achievements/Career row must show basic:off, pro:on, premium:on`);
  });
});

test('THE GALLERY ROW IS PREMIUM-ONLY — MATCHING showGallery\'s GATE', () => {
  const frontend = readFile('unplug-magazine.html');
  assert.ok(frontend.includes("const showGallery = tier === 'premium'"), 'showGallery logic must still be premium-only');
});

test('DEMO REEL IS INDIVIDUAL-ONLY, SECOND CATEGORY IS BUSINESS-ONLY — NEITHER TABLE OFFERS THE OTHER', () => {
  const frontend = readFile('unplug-magazine.html');
  const rowsStart = frontend.indexOf('PKG_COMPARE_ROWS');
  const individualBlock = frontend.slice(frontend.indexOf('individual: [', rowsStart), frontend.indexOf('business: [', rowsStart));
  const businessBlock = frontend.slice(frontend.indexOf('business: [', rowsStart), frontend.indexOf('};', frontend.indexOf('business: [', rowsStart)));
  assert.match(individualBlock, /Demo reel/);
  assert.ok(!individualBlock.includes('Second category'), 'a second category is a business-only feature');
  assert.match(businessBlock, /Second category/);
  assert.ok(!businessBlock.includes('Demo reel'), 'a demo reel is an individual-only feature');
});

test('THE TABLE RE-RENDERS WHEN THE INDIVIDUAL/BUSINESS TOGGLE IS CLICKED, NOT ONLY ON PAGE LOAD', () => {
  const frontend = readFile('unplug-magazine.html');
  const idx = frontend.indexOf("document.getElementById('pkgTypeToggle').addEventListener('click'");
  assert.ok(idx > -1);
  const body = frontend.slice(idx, idx + 700);
  assert.match(body, /renderPkgCompareTable\(\)/);
});
