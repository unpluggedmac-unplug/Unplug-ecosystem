// PAY-003 and PAY-010, checked against the real checkout page rather than
// assumed.
//
// PAY-003 ("what happens after payment"): only a Directory package purchase
// has a real review → approval → activation step after paying — an edition
// download or a vote bundle settles the instant payment is confirmed. A
// generic "here's what happens next" note would be actively wrong for
// those, so this is gated on DIRECTORY_MODE specifically, not shown site-wide.
//
// PAY-010 (validation): the punch-list's complaint is a GENERIC "something
// went wrong" replacing a specific, field-relevant message. Checked that
// every showError() call in checkout.html either passes a specific literal
// string or falls through to the server's own err.message first — never a
// bare catch-all.
//
// Website remediation punch-list (2026-09-03).
//
// Run with:  npm test   (from unplug-backend/)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', '..', 'unplug-checkout.html');

function read() {
  assert.ok(fs.existsSync(FILE), 'unplug-checkout.html should exist');
  return fs.readFileSync(FILE, 'utf8').split('\r\n').join('\n');
}

test('THE POST-PAYMENT WORKFLOW NOTE EXISTS AND NAMES THE REAL STEPS (confirm, review, live)', () => {
  const src = read();
  const idx = src.indexOf('id="paymentNextSteps"');
  assert.ok(idx > -1);
  const tag = src.slice(idx, idx + 400);
  assert.match(tag, /confirm/i);
  assert.match(tag, /review/i);
  assert.match(tag, /live/i);
});

test('THE WORKFLOW NOTE IS GATED ON DIRECTORY_MODE — an edition download or vote bundle must not show a review step that does not apply to them', () => {
  const src = read();
  const idx = src.indexOf("getElementById('paymentNextSteps').style.display = 'block'");
  assert.ok(idx > -1);
  const before = src.slice(Math.max(0, idx - 200), idx);
  assert.match(before, /if\s*\(DIRECTORY_MODE\)/);
});

test('NO showError() CALL SITE FALLS BACK TO A GENERIC "SOMETHING WENT WRONG" — every message is specific to what failed', () => {
  const src = read();
  const calls = [...src.matchAll(/showError\([^)]*\)/g)].map((m) => m[0]);
  assert.ok(calls.length >= 10, 'expected many showError call sites across the checkout flows');
  const vague = /something went wrong|an error occurred|please try again$/i;
  calls.forEach((call) => {
    assert.ok(!vague.test(call), `showError call reads as a generic catch-all: ${call}`);
  });
});
