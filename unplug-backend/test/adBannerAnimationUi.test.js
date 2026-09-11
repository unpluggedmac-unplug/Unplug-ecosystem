// Ad Banners admin UI — the per-row "Entrance effect" / "Shows for (seconds)"
// fields. The real behaviour (validation, defaults, the public route
// returning the saved values) is covered by adBannerAnimation.test.js; this
// file only checks the admin dashboard wiring that calls those routes.
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

test('EVERY BANNER ROW HAS AN ENTRANCE-EFFECT SELECT WITH THE FULL 8-VALUE VOCABULARY', () => {
  const src = readAdmin();
  const idx = src.indexOf('function adBannerRowHtml(');
  assert.ok(idx > -1);
  const body = src.slice(idx, src.indexOf('function adSlotSpec', idx));
  assert.match(body, /class="ad-anim"/);
  ['fade', 'none', 'fade-up', 'slide-up', 'slide-down', 'slide-left', 'slide-right', 'zoom'].forEach((v) => {
    assert.match(body, new RegExp(`value="${v}"`), `${v} must be a choosable effect`);
  });
  assert.match(body, /class="ad-display-secs"/);
});

test('LOADING AN EXISTING BANNER POPULATES BOTH NEW FIELDS FROM THE SERVER VALUES', () => {
  const src = readAdmin();
  const idx = src.indexOf('function fillAdBannerRow(row, banner, slotKey)');
  assert.ok(idx > -1);
  const body = src.slice(idx, src.indexOf('\n}', idx));
  assert.match(body, /ad-anim'\)\.value = banner\.animation_effect \|\| 'fade'/);
  assert.match(body, /ad-display-secs'\)\.value = Math\.round\(\(banner\.display_duration_ms \|\| 5000\) \/ 1000\)/);
});

test('SAVING SENDS BOTH FIELDS, WITH SECONDS CONVERTED TO MILLISECONDS', () => {
  const src = readAdmin();
  const idx = src.indexOf('function wireAdBannerRow(row, slotKey, bannerId)');
  assert.ok(idx > -1);
  const body = src.slice(idx, src.indexOf('async function moderateBanner', idx));
  assert.match(body, /animationEffect: row\.querySelector\('\.ad-anim'\)\.value/);
  assert.match(body, /displayDurationMs: \(Number\(row\.querySelector\('\.ad-display-secs'\)\.value\) \|\| 5\) \* 1000/);
});
