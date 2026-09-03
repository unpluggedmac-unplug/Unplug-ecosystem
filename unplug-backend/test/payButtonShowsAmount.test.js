// MOB-003: the primary payment button on every checkout surface should say
// what it's about to charge — "PAY R400 BY EFT" — not a bare "Continue" /
// "Complete Order" that forces a member to scroll back up to the order
// summary to remember the amount. Most valuable on a small screen, where
// that summary is often already scrolled out of view by the time someone
// reaches the button, but the fix applies everywhere since the amount is
// worth confirming regardless of screen size.
//
// Checked live in-browser rather than assumed: unplug-checkout.html's
// payBtn, unplug-member-dashboard.html's Submit & Pay button, and its cart
// checkout button all previously said a bare "Complete Order"/"Create & Pay"
// with no figure on the button itself.
//
// Three surfaces, one convention: the label is built from POST
// /payments/quote's (or /orders/quote's) amountToPay/total — the same
// server-priced figure already shown in the order summary — plus the
// currently selected payment method, via a small payMethodLabel() helper
// duplicated per file (these are three independent static HTML files with
// no shared JS module for this).
//
// Website remediation punch-list (2026-09-03).
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

test('CHECKOUT: payBtn\'s LABEL IS BUILT FROM THE SERVER-PRICED amountToPay, NOT A HARDCODED "COMPLETE ORDER"', () => {
  const src = read('unplug-checkout.html');
  const idx = src.indexOf("const btn = document.getElementById('payBtn');");
  assert.ok(idx > -1);
  const block = src.slice(idx, idx + 400);
  assert.match(block, /PAY \$\{CR\(q\.amountToPay\)\} BY \$\{payMethodLabel/);
});

test('CHECKOUT: A FAILED PAYMENT ATTEMPT RESTORES THE REAL LABEL, NOT A BARE "PAY NOW"', () => {
  const src = read('unplug-checkout.html');
  const idx = src.indexOf("showError('paymentError', err.message);");
  assert.ok(idx > -1);
  const block = src.slice(idx, idx + 450);
  assert.match(block, /refreshCheckoutQuote\(\)/,
    'the finally block after a failed Pay Now must re-run refreshCheckoutQuote(), which rebuilds the PAY R… BY … label');
  assert.ok(!/textContent = 'Pay Now'/.test(block), 'must not fall back to a bare label on failure');
});

test('CHECKOUT: THE BUTTON REFRESHES WHEN THE PAYMENT METHOD CHANGES', () => {
  const src = read('unplug-checkout.html');
  assert.match(src, /getElementById\('paymentMethod'\)\.addEventListener\('change', refreshCheckoutQuote\)/);
});

test('SUBMIT & PAY: THE BUTTON LABEL IS BUILT FROM THE SERVER-PRICED amountToPay, NOT A HARDCODED "CREATE & PAY"', () => {
  const src = read('unplug-member-dashboard.html');
  const idx = src.indexOf("const payBtn = document.getElementById('submitAndPayBtn');");
  assert.ok(idx > -1);
  const block = src.slice(idx, idx + 300);
  assert.match(block, /PAY \$\{R\(q\.amountToPay\)\} BY \$\{payMethodLabel/);
});

test('SUBMIT & PAY: A FREE SUBMISSION KEEPS ITS OWN LABEL, NEVER OVERWRITTEN WITH A PRICE', () => {
  const src = read('unplug-member-dashboard.html');
  const idx = src.indexOf("if (btn) btn.textContent = isFree ? 'Submit for Approval'");
  assert.ok(idx > -1, 'the free-publishing branch must still set its own label before any quote is fetched');
});

test('CART CHECKOUT: THE BUTTON LABEL IS BUILT FROM THE SERVER-PRICED total, NOT A HARDCODED "COMPLETE ORDER"', () => {
  const src = read('unplug-member-dashboard.html');
  const idx = src.indexOf("document.getElementById('cartPayBtn').textContent = CART_QUOTE.total === 0");
  assert.ok(idx > -1);
  const block = src.slice(idx, idx + 250);
  assert.match(block, /PAY R\$\{Number\(CART_QUOTE\.total\)\.toFixed\(2\)\} BY \$\{payMethodLabel/);
});

test('CART CHECKOUT: A FAILED PAYMENT ATTEMPT RESTORES THE REAL LABEL VIA refreshCartQuote, NOT A BARE "COMPLETE ORDER"', () => {
  const src = read('unplug-member-dashboard.html');
  const idx = src.indexOf("if (btn.textContent === 'Processing…')");
  assert.ok(idx > -1);
  assert.match(src.slice(idx, idx + 90), /refreshCartQuote\(\)/);
});

test('EVERY PAY-METHOD LABEL FALLS BACK TO EFT — THE ONLY LIVE METHOD RIGHT NOW — AND NAMES PAYFAST/OZOW CORRECTLY IF SELECTED', () => {
  ['unplug-checkout.html', 'unplug-member-dashboard.html'].forEach((filename) => {
    const src = read(filename);
    const idx = src.indexOf('function payMethodLabel(method)');
    assert.ok(idx > -1, `${filename} should define payMethodLabel`);
    const body = src.slice(idx, idx + 200);
    assert.match(body, /'payfast'.*'PAYFAST'/);
    assert.match(body, /'ozow'.*'OZOW'/);
    assert.match(body, /'EFT'/);
  });
});
