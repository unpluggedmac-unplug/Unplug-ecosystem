// A member typed a voucher code and paid, with no way to see what it did (or
// didn't do) before committing. unplug-checkout.html was pure client-side
// arithmetic — Order total minus Credit, nothing else — that never asked the
// server about the voucher at all until the moment of payment. Submit & Pay
// (the member dashboard's other checkout) already did this properly via
// POST /payments/quote, an "Apply" button and a live discount row.
//
// Website remediation punch-list (2026-09-03), PAY-002.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', '..', 'unplug-checkout.html');

function read() {
  assert.ok(fs.existsSync(FILE), 'unplug-checkout.html should exist');
  return fs.readFileSync(FILE, 'utf8').split('\r\n').join('\n');
}

test('THE VOUCHER HAS AN APPLY BUTTON AND A LIVE DISCOUNT ROW', () => {
  const src = read();
  assert.ok(src.includes('id="applyVoucherBtn"'), 'an Apply button should exist');
  assert.ok(src.includes('id="sumVoucherLine"'), 'a voucher-discount row should exist in the summary');
  assert.ok(src.includes('id="sumVoucher"'));
});

test('THE SUMMARY IS BUILT FROM /payments/quote, NOT CLIENT ARITHMETIC', () => {
  const src = read();
  assert.match(src, /api\('\/payments\/quote'/, 'the summary should ask the server, not compute the total itself');
  // The old pure-arithmetic function must actually be gone, not just
  // supplemented — two ways of pricing the same order is the bug class this
  // fixes, not a pattern to keep half of.
  assert.ok(!/function recalcCheckout/.test(src), 'the old client-only pricing function should be removed, not left dead');
  assert.ok(!/CURRENT_ORDER_TOTAL/.test(src), 'pricing should not be tracked in a client-side total anymore');
});

test('APPLYING A VOUCHER RE-QUOTES RATHER THAN JUST STASHING TEXT', () => {
  const src = read();
  const start = src.indexOf("getElementById('applyVoucherBtn')");
  assert.ok(start > -1);
  const handler = src.slice(start, start + 500);
  assert.match(handler, /refreshCheckoutQuote/, 'clicking Apply should trigger a live quote, not just remember the text');
});

test('PAYING USES THE APPLIED, SERVER-VALIDATED VOUCHER — NOT WHATEVER TEXT SITS IN THE BOX', () => {
  // Typing a new, unapplied code and then clicking pay must not silently
  // charge a discount the order summary never showed.
  const src = read();
  const payStart = src.indexOf("getElementById('payBtn').addEventListener");
  assert.ok(payStart > -1);
  const payHandler = src.slice(payStart, payStart + 1600);
  assert.match(payHandler, /APPLIED_VOUCHER/);
  assert.ok(!/document\.getElementById\('voucherCode'\)\.value\.trim\(\)/.test(payHandler),
    'the pay handler should not re-read the raw input directly');
});

test('CHANGING "USE MY CREDIT" RE-QUOTES TOO, NOT JUST THE VOUCHER', () => {
  const src = read();
  assert.match(src, /getElementById\('useCreditChk'\)\.addEventListener\('change',\s*refreshCheckoutQuote\)/);
});
