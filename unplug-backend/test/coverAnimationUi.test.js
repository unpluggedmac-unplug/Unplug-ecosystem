// Part 3 of "admin control over banner/cover animation effects" — the Cover
// Images admin screen's animation fields. The real behaviour (validation,
// scoping to article/directory/edition only) is covered by
// coverAnimation.test.js; this file only checks the admin dashboard wiring.
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

test('THE COVER EDITOR HAS AN ANIMATION FIELDS BLOCK, HIDDEN BY DEFAULT, WITH THE FULL 8-VALUE VOCABULARY', () => {
  const src = readAdmin();
  const idx = src.indexOf('id="coverAnimFields"');
  assert.ok(idx > -1);
  const body = src.slice(idx, src.indexOf('</div>\n          <div style="display:none;">', idx));
  ['none', 'fade', 'fade-up', 'slide-up', 'slide-down', 'slide-left', 'slide-right', 'zoom'].forEach((v) => {
    assert.match(body, new RegExp(`value="${v}"`), `${v} must be a choosable effect`);
  });
  assert.match(body, /id="coverAnimDur"/);
});

test('LOADING THE COVER LIST CAPTURES hasAnim FROM THE SERVER', () => {
  const src = readAdmin();
  const idx = src.indexOf('async function loadCoverManager()');
  assert.ok(idx > -1);
  const body = src.slice(idx, src.indexOf('\n}', idx));
  assert.match(body, /_coverHasAnim = d\.hasAnim \|\| false/);
});

test('OPENING AN ITEM FOR EDIT SHOWS THE ANIMATION FIELDS ONLY WHEN hasAnim, AND POPULATES THEM FROM THE ITEM', () => {
  const src = readAdmin();
  const idx = src.indexOf('async function editCover(id)');
  assert.ok(idx > -1);
  const body = src.slice(idx, src.indexOf('\nfunction cancelCoverEdit', idx));
  assert.match(body, /animFields\.style\.display = _coverHasAnim \? 'flex' : 'none'/);
  assert.match(body, /coverAnimSelect'\)\.value = it\.anim \|\| 'none'/);
  assert.match(body, /coverAnimDur'\)\.value = it\.anim_dur \|\| 400/);
});

test('SAVING ONLY SENDS THE ANIMATION FIELDS WHEN THIS TYPE ACTUALLY HAS THEM', () => {
  const src = readAdmin();
  const idx = src.indexOf('async function saveCover(remove)');
  assert.ok(idx > -1);
  const body = src.slice(idx, src.indexOf('\n}', src.indexOf('showToast(remove', idx)));
  assert.match(body, /if \(_coverHasAnim\) \{/);
  assert.match(body, /body\.animationEffect = document\.getElementById\('coverAnimSelect'\)\.value/);
  assert.match(body, /body\.transitionDurationMs = Number\(document\.getElementById\('coverAnimDur'\)\.value\) \|\| 400/);
});

test('THE BACKEND ONLY DECLARES animCol/durCol FOR article, directory, AND edition — NOT THE OTHER SIX RESOURCE TYPES', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'adminCovers.js'), 'utf8');
  const idx = src.indexOf('const COVERS = {');
  const body = src.slice(idx, src.indexOf('\n};', idx));
  const animColCount = (body.match(/animCol:/g) || []).length;
  assert.equal(animColCount, 3, 'exactly article/directory/edition should declare animCol');
});
