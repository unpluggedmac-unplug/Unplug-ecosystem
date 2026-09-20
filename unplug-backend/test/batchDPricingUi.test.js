'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\r\n').join('\n');
}

const checkout = read('unplug-checkout.html');
const magazine = read('unplug-magazine.html');
const chatbot = read('chatbot.js');
const admin = read('unplug-admin-dashboard.html');
const payments = read('unplug-backend/src/routes/payments.js');
const servicePackages = read('unplug-backend/src/utils/servicePackages.js');
const directoryPackages = read('unplug-backend/src/utils/directoryPackages.js');

test('all Directory price surfaces use the same backend endpoint', () => {
  assert.match(checkout, /api\('\/payments\/directory-packages'\)/);
  assert.match(magazine, /api\('\/payments\/directory-packages'\)/);
  assert.match(chatbot, /\/payments\/directory-packages/);
  assert.match(admin, /\/payments\/admin\/directory-packages/);
  assert.match(payments, /router\.get\('\/directory-packages'/);
  assert.match(payments, /router\.get\('\/admin\/directory-packages'/);
  assert.match(payments, /router\.patch\('\/admin\/directory-packages\/:id'/);
});

test('old hardcoded Directory price tables and stale chatbot business prices stay gone', () => {
  assert.doesNotMatch(payments, /const\s+PACKAGE_PRICES\s*=/);
  assert.doesNotMatch(magazine, /const\s+PKG_PRICES\s*=\s*\{[\s\S]{0,300}basic:\s*\d/);
  assert.doesNotMatch(checkout, /const\s+TIER_PRICES\s*=\s*\{[\s\S]{0,300}basic:\s*\d/);
  assert.doesNotMatch(chatbot, /Business:\s*Basic R600\s*\/\s*Pro R1000\s*\/\s*Premium R1500/i);
  assert.doesNotMatch(chatbot, /Business:\s*R600\s*\/\s*R1000\s*\/\s*R1500/i);
});

test('member-facing Directory prices start neutral and fail unavailable rather than stale', () => {
  for (const tier of ['basic', 'pro', 'premium']) {
    assert.match(magazine, new RegExp('class="pkg-price" data-tier="' + tier + '">Loading…<'));
  }
  assert.match(checkout, /id="createProfileBtn" disabled/);
  assert.match(checkout, /Directory pricing is temporarily unavailable/);
  assert.match(magazine, /priceEl\.textContent = price === null \? 'Unavailable'/);
  assert.match(magazine, /btn\.disabled = price === null/);
});

test('Directory charging has no literal price ladder in runtime code', () => {
  assert.match(payments, /priceForDirectoryPackage\(type, package_tier\)/);
  assert.match(directoryPackages, /FROM directory_package_prices/);
  assert.doesNotMatch(directoryPackages, /(?:basic|pro|premium)\s*:\s*\d/i,
    'runtime code must not map Directory tiers to literal prices');
});

test('duration-based pricing has no hardcoded fallback and explicitly fails unavailable', () => {
  assert.doesNotMatch(servicePackages, /FALLBACK_PRICES/);
  assert.match(servicePackages, /PRICING_UNAVAILABLE/);
  assert.match(servicePackages, /throw pricingUnavailable\(\)/);
  assert.match(payments, /No payment was created/);
});

test('paid forms remain outside Batch D', () => {
  assert.doesNotMatch(payments, /linkedType === 'form_payment'/,
    'Batch D decision 3A keeps paid-form charging out of payments.js');
});
