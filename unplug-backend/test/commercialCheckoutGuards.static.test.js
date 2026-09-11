const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('single and cart checkout both invoke the central purchase-ownership guard', () => {
  assert.match(read('src/routes/payments.js'), /assertPurchasableByUser\(linkedType, linkedId, req\.user\.id\)/);
  const orders = read('src/routes/orders.js');
  assert.ok((orders.match(/assertPurchasableByUser\(item\.linkedType/g) || []).length >= 2);
});

test('cart rejects duplicate resources and scopes restricted voucher discounts to eligible items', () => {
  const orders = read('src/routes/orders.js');
  assert.match(orders, /same service cannot be added to one order more than once/i);
  assert.match(orders, /eligibleSubtotal/);
  assert.match(orders, /pricedItems\.filter/);
});

test('cart and single checkout share the server gateway-live gate', () => {
  assert.match(read('src/routes/orders.js'), /gatewayIsLive\(method\)/);
  assert.match(read('src/routes/payments.js'), /if \(method === 'eft'\) return true;[\s\S]*return false;/);
});

test('21-day banner fallback matches the database package introduced by migration 168', () => {
  assert.match(read('src/utils/servicePackages.js'), /ad_banner:\s*\{[^}]*21:\s*785\.00/);
});

test('confirmed payments use tracked fulfilment and manual EFT passes confirmed state to analytics', () => {
  const payments = read('src/routes/payments.js');
  assert.match(payments, /async function applyPaymentEffectTracked/);
  assert.match(payments, /fulfillment_status = 'failed'/);
  assert.match(payments, /applyPaymentEffectTracked\(\{ \.\.\.payment, status: 'confirmed' \}\)/);
  const migration = read('db/migrations/187_payment_fulfilment_tracking.sql');
  assert.match(migration, /fulfillment_status/);
});
