// Part 4 of "admin control over banner/cover animation effects" — the
// Highlighted Articles admin form's override fields. The real behaviour
// (validation, the NULL-means-inherit relationship) is covered by
// highlightAnimationOverride.test.js; this file only checks the admin
// dashboard wiring.
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

test('THE HIGHLIGHT FORM HAS AN OVERRIDE-EFFECT SELECT, WITH A "USE THE OWN SETTING" OPTION PLUS THE FULL 8-VALUE VOCABULARY', () => {
  const src = readAdmin();
  const idx = src.indexOf('id="hlAnim"');
  assert.ok(idx > -1);
  const body = src.slice(idx, src.indexOf('</select>', idx));
  assert.match(body, /value=""/, 'an empty value must mean "use the article/profile\'s own"');
  ['none', 'fade', 'fade-up', 'slide-up', 'slide-down', 'slide-left', 'slide-right', 'zoom'].forEach((v) => {
    assert.match(body, new RegExp(`value="${v}"`), `${v} must be a choosable override`);
  });
  assert.match(src, /id="hlAnimDur"/);
});

test('SAVING SENDS BOTH OVERRIDE FIELDS AS EXPLICIT null WHEN LEFT BLANK, NOT OMITTED', () => {
  const src = readAdmin();
  const idx = src.indexOf('async function saveHighlight()');
  assert.ok(idx > -1);
  const body = src.slice(idx, src.indexOf('\n}', idx));
  assert.match(body, /animationEffect: document\.getElementById\('hlAnim'\)\.value \|\| null/);
  assert.match(body, /transitionDurationMs: document\.getElementById\('hlAnimDur'\)\.value \? Number\(document\.getElementById\('hlAnimDur'\)\.value\) : null/);
});

test('EDITING AN EXISTING HIGHLIGHT POPULATES BOTH OVERRIDE FIELDS FROM ITS STORED VALUES', () => {
  const src = readAdmin();
  const idx = src.indexOf('function editHighlight(id)');
  assert.ok(idx > -1);
  const body = src.slice(idx, src.indexOf('\n}', idx));
  assert.match(body, /hlAnim'\)\.value = h\.animation_effect \|\| ''/);
  assert.match(body, /hlAnimDur'\)\.value = h\.transition_duration_ms \|\| ''/);
});

test('RESETTING THE FORM CLEARS BOTH OVERRIDE FIELDS BACK TO "USE THE OWN SETTING"', () => {
  const src = readAdmin();
  const idx = src.indexOf('function resetHighlightForm()');
  assert.ok(idx > -1);
  const body = src.slice(idx, src.indexOf('\n}', idx));
  assert.match(body, /hlAnim'\)\.value = ''/);
  assert.match(body, /hlAnimDur'\)\.value = ''/);
});
