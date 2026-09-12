const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const RUNTIME = path.join(ROOT, 'functions', 'runtime-config.js');
const TOOLS = path.join(ROOT, 'media', 'scripts', 'unplug-account-tools.js');
const CHECKOUT = path.join(ROOT, 'unplug-checkout.html');
const VOTE = path.join(ROOT, 'unplug-vote.html');

function read(file) {
  assert.ok(fs.existsSync(file), `${path.relative(ROOT, file)} should exist`);
  return fs.readFileSync(file, 'utf8').split('\r\n').join('\n');
}

test('runtime config loads the account/checkout continuity helper site-wide', () => {
  const src = read(RUNTIME);
  assert.match(src, /unplug-account-tools\.js\?v=20260912-1/);
  assert.match(src, /__unplugAccountToolsRequested/);
});

test('standalone user portals can sign in and sign out without replacing existing richer account UIs', () => {
  const src = read(TOOLS);
  assert.match(src, /\/auth\/login/);
  assert.match(src, /\/auth\/me/);
  assert.match(src, /Sign In/);
  assert.match(src, /Sign Out/);
  assert.match(src, /localStorage\.removeItem\(TOKEN_KEY\)/);
  assert.match(src, /unplug:auth-changed/);
  assert.match(src, /document\.getElementById\('navAccount'\)/);
  assert.match(src, /unplug-member-dashboard/);
  assert.match(src, /unplug-admin-dashboard/);
});

test('checkout and bulk-vote portals still expose the same mandatory Terms gate', () => {
  for (const file of [CHECKOUT, VOTE]) {
    const src = read(file);
    assert.match(src, /class="[^"]*viewTermsLink/);
    assert.match(src, /id="termsAcceptChk"[^>]*disabled/);
    assert.match(src, /id="payBtn"[^>]*disabled/);
  }
});

test('Terms links now preserve checkout state and require explicit acceptance on the real policy page', () => {
  const src = read(TOOLS);
  assert.match(src, /closest\('\.viewTermsLink'\)/);
  assert.match(src, /e\.preventDefault\(\)/);
  assert.match(src, /e\.stopImmediatePropagation\(\)/);
  assert.match(src, /terms_review/);
  assert.match(src, /window\.open\(url\.toString\(\), '_blank'\)/);
  assert.match(src, /params\.get\('p'\) !== 'refunds'/);
  assert.match(src, /I understand — Accept & Continue/);
});

test('accepting Terms returns to checkout and checks the existing gate instead of bypassing it', () => {
  const src = read(TOOLS);
  assert.match(src, /checkbox\.disabled = false/);
  assert.match(src, /checkbox\.checked = true/);
  assert.match(src, /checkbox\.dispatchEvent\(new Event\('change'/);
  assert.match(src, /unplug_terms_accept_payload/);
  assert.match(src, /window\.opener\.focus\(\)/);
  assert.match(src, /window\.close\(\)/);
  assert.match(src, /url\.searchParams\.set\('terms_accept', reviewId\)/);
});
