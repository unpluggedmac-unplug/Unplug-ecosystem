// Part 5 of "admin control over banner/cover animation effects" — the Site
// Settings admin UI's Feature Edition fields. The real behaviour
// (validation, /public-settings whitelisting) is covered by
// featureEditionAnimation.test.js; this file only checks the admin
// dashboard wiring and the public page's own render logic.
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
function readMagazine() {
  const file = path.join(__dirname, '..', '..', 'unplug-magazine.html');
  assert.ok(fs.existsSync(file));
  return fs.readFileSync(file, 'utf8').split('\r\n').join('\n');
}

test('SITE SETTINGS HAS A FEATURE EDITION ANIMATION PANEL, DEFAULTING TO "zoom"', () => {
  const src = readAdmin();
  const idx = src.indexOf('id="feAnimSelect"');
  assert.ok(idx > -1);
  const body = src.slice(idx, src.indexOf('</select>', idx));
  assert.match(body, /value="zoom"/);
  ['none', 'fade', 'fade-up', 'slide-up', 'slide-down', 'slide-left', 'slide-right'].forEach((v) => {
    assert.match(body, new RegExp(`value="${v}"`), `${v} must be a choosable effect`);
  });
  assert.match(src, /id="feAnimDur"/);
});

test('LOADING SITE SETTINGS POPULATES BOTH FIELDS, DEFAULTING TO zoom/24000 IF UNSET', () => {
  const src = readAdmin();
  const idx = src.indexOf('async function loadSiteSettings()');
  assert.ok(idx > -1);
  const body = src.slice(idx, src.indexOf('\n}', idx));
  assert.match(body, /feAnimSelect'\)\.value = feEffect \? feEffect\.value : 'zoom'/);
  assert.match(body, /feAnimDur'\)\.value = feDur \? feDur\.value : '24000'/);
});

test('SAVING SENDS TWO SEPARATE PATCH CALLS, ONE PER SETTING KEY', () => {
  const src = readAdmin();
  const idx = src.indexOf("getElementById('saveFeAnimBtn').addEventListener('click'");
  assert.ok(idx > -1);
  const body = src.slice(idx, src.indexOf('\n});', idx));
  assert.match(body, /\/admin\/settings\/feature_edition_animation_effect/);
  assert.match(body, /\/admin\/settings\/feature_edition_transition_duration_ms/);
});

test('THE PUBLIC PAGE FETCHES /public-settings AND SETS data-anim/--anim-dur ON THE FEATURE EDITION IMAGE, FALLING BACK TO zoom/24000ms ON FAILURE', () => {
  const src = readMagazine();
  const idx = src.indexOf('async function applyFeatureEditionAnimation()');
  assert.ok(idx > -1);
  const body = src.slice(idx, src.indexOf('\n}', src.indexOf('catch (err)', idx)));
  assert.match(body, /api\('\/public-settings'\)/);
  assert.match(body, /setAttribute\('data-anim', effect\)/);
  assert.match(body, /setProperty\('--anim-dur', dur \+ 'ms'\)/);
  assert.match(body, /setAttribute\('data-anim', 'zoom'\)/, 'failure fallback must keep the original look');
});

test('THE CSS KEEPS featureZoomOut AS ITS OWN BESPOKE KEYFRAME, NOT FOLDED INTO THE SHARED FAST-ENTRANCE LIBRARY', () => {
  const src = readMagazine();
  assert.match(src, /@keyframes featureZoomOut\{ from\{ transform:scale\(1\.18\); \} to\{ transform:scale\(1\); \} \}/);
  assert.match(src, /\.feature-edition-thumb img\[data-anim="zoom"\]\s*\{ transform:scale\(1\.18\); animation:featureZoomOut var\(--anim-dur,24s\) ease-out both; \}/);
});
