// Floating Buttons (Site Buttons) — letting an admin pick "a page on this
// site" instead of having to know/type the exact internal URL shape.
// Requested directly: "allow admin to link button with any external link
// and allow admin to choose page on website."
//
// The backend (siteButtons.js) already stored `url` as a free-text column
// with no shape validation, so "any external link" already worked — this is
// a static check on the ADMIN DASHBOARD markup/wiring only, since the fix is
// entirely a friendlier way to compose that same string, not a new API.
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

test('THE ADD-BUTTON FORM OFFERS A CHOICE BETWEEN AN EXTERNAL LINK AND A PAGE ON THIS SITE', () => {
  const src = readAdmin();
  const idx = src.indexOf('id="sbLinkType"');
  assert.ok(idx > -1, 'a link-type selector must exist');
  const nearby = src.slice(Math.max(0, idx - 200), idx + 200);
  assert.match(nearby, /value="external"/);
  assert.match(nearby, /value="page"/);
});

test('THE PAGE PICKER LISTS REAL PAGES, INCLUDING IMPACT MAKERS', () => {
  const src = readAdmin();
  const idx = src.indexOf('id="sbPageSelect"');
  assert.ok(idx > -1);
  const body = src.slice(idx, src.indexOf('</select>', idx));
  ['home', 'directory', 'contact', 'impact-makers'].forEach((page) => {
    assert.match(body, new RegExp(`value="${page}"`), `${page} should be a choosable page`);
  });
});

test('CHOOSING "PAGE ON THIS SITE" SWAPS THE FREE-TEXT LINK FIELD FOR THE PAGE DROPDOWN', () => {
  const src = readAdmin();
  const idx = src.indexOf("getElementById('sbLinkType').addEventListener('change'");
  assert.ok(idx > -1);
  const body = src.slice(idx, src.indexOf('});', idx));
  assert.match(body, /sbUrlField/);
  assert.match(body, /sbPageField/);
});

test('SUBMITTING WITH "PAGE ON THIS SITE" COMPOSES THE EXACT SHAPE unplug-site-buttons.js EXPECTS FOR AN INTERNAL LINK', () => {
  const src = readAdmin();
  const idx = src.indexOf("getElementById('createSiteButtonBtn').addEventListener('click'");
  assert.ok(idx > -1);
  const body = src.slice(idx, src.indexOf('\n});', idx));
  assert.match(body, /'unplug-magazine\.html\?p=' \+ document\.getElementById\('sbPageSelect'\)\.value/,
    'must match unplug-site-buttons.js\'s own documented shape for an internal link, or the button silently 404s');
  // The plain custom-URL path must still be untouched — any external link,
  // unrestricted, exactly like before this change.
  assert.match(body, /document\.getElementById\('sbUrlInput'\)\.value\.trim\(\)/);
});
