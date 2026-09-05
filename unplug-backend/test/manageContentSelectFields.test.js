// Part 2 of "admin control over banner/cover animation effects": the Manage
// Content generic editor (unplug-admin-dashboard.html) gained real <select>
// support, so a resource's enum column (marketplace_listings.animation_effect)
// renders as a real dropdown instead of a free-text box an admin could
// mistype. This is a genuine generalisation of the shared editor, not a
// marketplace-only special case — this file checks that wiring; the real
// behaviour (validation, the enum itself) is covered by
// marketplacePosterAnimation.test.js.
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

test('LOADING A RESOURCE CAPTURES THE SERVER-DECLARED selectFields ALONGSIDE editable', () => {
  const src = readAdmin();
  const idx = src.indexOf('async function loadManageContent()');
  assert.ok(idx > -1);
  const body = src.slice(idx, src.indexOf('\n}', src.indexOf('body.appendChild(table);', idx)));
  assert.match(body, /manageSelectFields = data\.selectFields \|\| \{\}/);
});

test('A FIELD DECLARED IN selectFields RENDERS AS A REAL <select>, NOT A TEXT INPUT', () => {
  const src = readAdmin();
  const idx = src.indexOf('function openManageEditor(resource, item)');
  assert.ok(idx > -1);
  const body = src.slice(idx, src.indexOf('document.getElementById(\'manageLoadBtn\')', idx));
  assert.match(body, /const options = manageSelectFields\[field\]/);
  assert.match(body, /document\.createElement\(options \? 'select' : /, 'a select-declared field must become a real <select> element');
});

test('A FIELD NAME ENDING IN _ms GETS A NUMBER INPUT, NOT PLAIN TEXT', () => {
  const src = readAdmin();
  const idx = src.indexOf('function openManageEditor(resource, item)');
  const body = src.slice(idx, src.indexOf('document.getElementById(\'manageLoadBtn\')', idx));
  assert.match(body, /field\.endsWith\('_ms'\)/);
});

test('THE marketplace RESOURCE DECLARES animation_effect AS A SELECT FIELD, BACKED BY THE SAME 8-VALUE ENUM AD BANNERS USE', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'adminContent.js'), 'utf8');
  const idx = src.indexOf("marketplace: {");
  assert.ok(idx > -1);
  const body = src.slice(idx, src.indexOf('highlights: {', idx));
  assert.match(body, /selectFields:/);
  assert.match(body, /animation_effect: \['none', 'fade', 'fade-up', 'slide-up', 'slide-down', 'slide-left', 'slide-right', 'zoom'\]/);
});
