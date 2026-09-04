// MOB-002: checkout at 320px width had real horizontal overflow — found by
// emulating a 320px viewport and measuring document.documentElement's
// scrollWidth vs clientWidth directly, not by eyeballing a screenshot.
// scrollWidth came back 354 against a 320 clientWidth, and walking every
// element's getBoundingClientRect() pinned the offender exactly:
// #applyVoucherBtn, pushed off-screen by its sibling voucher <input>.
//
// The input had `flex:1` and nothing else. A flex item's default min-width
// is `auto` — its own content/intrinsic size — so flex:1 alone does not let
// it shrink past that, and on a narrow screen the row (input + gap + Apply
// button) simply doesn't fit. `min-width:0` is the standard fix: it lets
// the item shrink to whatever the row actually has room for.
//
// The exact same input+button shape existed in two more places
// (unplug-member-dashboard.html's Submit & Pay and cart-checkout voucher
// rows) plus a similar two-input shape (the Article submission form's
// dynamically-added link rows) — all fixed together since they're the same
// bug, found by grepping for the same `style="flex:1;"` pattern rather than
// assuming checkout.html was the only place it existed.
//
// Website remediation punch-list (2026-09-03), MOB-002.
//
// Run with:  npm test   (from unplug-backend/)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function read(filename) {
  const file = path.join(__dirname, '..', '..', filename);
  assert.ok(fs.existsSync(file), `${filename} should exist`);
  return fs.readFileSync(file, 'utf8').split('\r\n').join('\n');
}

test('CHECKOUT: THE VOUCHER INPUT CAN SHRINK BELOW ITS OWN CONTENT SIZE, SO ITS Apply BUTTON STAYS ON SCREEN AT 320PX', () => {
  const src = read('unplug-checkout.html');
  const idx = src.indexOf('id="voucherCode"');
  assert.ok(idx > -1);
  assert.match(src.slice(idx, idx + 80), /min-width:0/);
});

test('SUBMIT & PAY: THE VOUCHER INPUT HAS THE SAME FIX', () => {
  const src = read('unplug-member-dashboard.html');
  const idx = src.indexOf('id="submitVoucher"');
  assert.ok(idx > -1);
  assert.match(src.slice(idx, idx + 80), /min-width:0/);
});

test('CART CHECKOUT: THE VOUCHER INPUT HAS THE SAME FIX', () => {
  const src = read('unplug-member-dashboard.html');
  const idx = src.indexOf('id="cartVoucher"');
  assert.ok(idx > -1);
  assert.match(src.slice(idx, idx + 80), /min-width:0/);
});

test('ARTICLE LINK ROWS: BOTH INPUTS HAVE THE SAME FIX, NOT JUST THE FIRST ONE', () => {
  const src = read('unplug-member-dashboard.html');
  const idx = src.indexOf('art-link-label');
  assert.ok(idx > -1);
  const block = src.slice(idx, idx + 250);
  const matches = block.match(/min-width:0/g) || [];
  assert.equal(matches.length, 2, 'both the label and URL inputs need the fix — a Remove button sits after them in the same row');
});
