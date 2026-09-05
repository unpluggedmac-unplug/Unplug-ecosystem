// Directory Profiles admin UI — the "Add a new listing" panel and the
// editor's "Delete listing" button. The real behaviour (POST/DELETE
// /admin/profiles, and the nullable-owner schema change) is covered by
// adminCreatedProfiles.test.js; this file only checks the admin dashboard
// wiring that calls those routes.
//
// Run with:  npm test   (from unplug-backend/)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function readAdmin() {
  const file = path.join(__dirname, '..', '..', 'unplug-admin-dashboard.html');
  assert.ok(fs.existsSync(file));
  return fs.readFileSync(file, 'utf8').split('\r\n').join('\n');
}

test('THE "ADD A NEW LISTING" FORM EXISTS, WITH THE THREE FIELDS profiles NEEDS AT CREATION', () => {
  const src = readAdmin();
  assert.match(src, /<h3>Add a new listing<\/h3>/);
  assert.match(src, /id="dpNewName"/);
  assert.match(src, /id="dpNewType"/);
  assert.match(src, /id="dpNewTier"/);
  assert.match(src, /id="dpNewCategory"/);
});

test('CREATING A LISTING POSTS TO /admin/profiles, THEN JUMPS STRAIGHT INTO THE EDITOR FOR IT', () => {
  const src = readAdmin();
  const idx = src.indexOf("getElementById('dpCreateBtn').addEventListener('click'");
  assert.ok(idx > -1);
  const body = src.slice(idx, src.indexOf('\n});', idx));
  assert.match(body, /api\('\/admin\/profiles', \{/);
  assert.match(body, /method: 'POST'/);
  assert.match(body, /dpLoadProfile\(data\.profile\.id, data\.profile\.slug\)/);
});

test('THE EDITOR HAS A DELETE BUTTON, GATED BEHIND A CONFIRM, WHICH CALLS DELETE /admin/profiles/:id', () => {
  const src = readAdmin();
  assert.match(src, /id="dpDeleteBtn"/);
  const idx = src.indexOf("getElementById('dpDeleteBtn').addEventListener('click'");
  assert.ok(idx > -1);
  const body = src.slice(idx, src.indexOf('\n});', idx));
  assert.match(body, /confirm\(/);
  assert.match(body, /method: 'DELETE'/);
  assert.match(body, /api\(`\/admin\/profiles\/\$\{DP_CURRENT\.id\}`/);
});

// The create form's requirements match exactly what a member fills in at
// their own checkout package step (unplug-checkout.html) — second category
// Business+Premium only, demo reel Individual+Premium only, location
// entirely optional with a street address for a business only.
test('THE CREATE FORM OFFERS THE SAME CONDITIONAL FIELDS A MEMBER SEES AT CHECKOUT', () => {
  const src = readAdmin();
  assert.match(src, /id="dpNewSecondCategoryField"/);
  assert.match(src, /id="dpNewSecondCategory"/);
  assert.match(src, /id="dpNewDemoReelField"/);
  assert.match(src, /id="dpNewDemoReelUrl"/);
  assert.match(src, /id="dpNewStreetField"/);
  assert.match(src, /id="dpNewStreetAddress"/);
  assert.match(src, /id="dpNewSuburb"/);
  assert.match(src, /id="dpNewCity"/);
  assert.match(src, /id="dpNewProvince"/);
  assert.match(src, /id="dpNewCountry"/);
});

test('CHANGING TYPE OR TIER RE-EVALUATES WHICH CONDITIONAL FIELDS SHOW, THE SAME RULE THE MEMBER CHECKOUT FORM USES', () => {
  const src = readAdmin();
  const idx = src.indexOf('function dpNewUpdateConditionalFields()');
  assert.ok(idx > -1);
  const body = src.slice(idx, src.indexOf('\n}', idx));
  assert.match(body, /isBusiness && tier === 'premium'/, 'second category: Business Premium only');
  assert.match(body, /!isBusiness && tier === 'premium'/, 'demo reel: Individual Premium only');
  assert.match(body, /dpNewStreetField.*toggle\('section-hidden', !isBusiness\)/);
  // Wired to both selects, so switching either re-checks visibility.
  assert.match(src, /getElementById\('dpNewType'\)\.addEventListener\('change', dpNewUpdateConditionalFields\)/);
  assert.match(src, /getElementById\('dpNewTier'\)\.addEventListener\('change', dpNewUpdateConditionalFields\)/);
});

test('SUBMITTING SENDS EVERY CONDITIONAL FIELD — THE BACKEND, NOT THE ADMIN UI, DECIDES WHICH ONES ACTUALLY APPLY', () => {
  const src = readAdmin();
  const idx = src.indexOf("getElementById('dpCreateBtn').addEventListener('click'");
  const body = src.slice(idx, src.indexOf('\n});', idx));
  ['secondaryCategoryId', 'demoReelUrl', 'streetAddress', 'suburb', 'city', 'province', 'country'].forEach((field) => {
    assert.match(body, new RegExp(field + ':'), `the create payload must include ${field}`);
  });
});
