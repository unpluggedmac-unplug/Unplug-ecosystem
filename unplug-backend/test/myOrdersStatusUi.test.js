'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const dashboard = fs.readFileSync(path.join(ROOT, 'unplug-member-dashboard.html'), 'utf8');
const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'orders.js'), 'utf8');
const resolver = fs.readFileSync(path.join(__dirname, '..', 'src', 'utils', 'orderServiceStatus.js'), 'utf8');

test('My Orders explains payment and service approval as separate facts', () => {
  assert.match(dashboard, /Payment and service approval are shown separately/i);
  assert.match(dashboard, /paymentLabel\.textContent = 'Payment'/);
  assert.match(dashboard, /serviceLabel\.textContent = 'Services'/);
  assert.match(dashboard, /Payment: .*paymentStatusLabel/);
  assert.match(dashboard, /Service: .*serviceStatusLabel/);
});

test('the API derives service status rather than adding approval status to orders', () => {
  assert.match(route, /loadOrderServiceStatuses/);
  assert.match(route, /serviceStatusSummary/);
  assert.doesNotMatch(route, /orders\.approval_status|o\.approval_status/);
  assert.match(resolver, /Mixed status ·/);
});

test('all ten cart service types are represented by standard or explicit status logic', () => {
  for (const type of [
    'profile_package','profile_upgrade','competition_entry','highlight',
    'marketplace_listing','article_publish','event_listing','gallery_bundle',
    'top10_entry','ad_banner',
  ]) {
    assert.match(resolver, new RegExp(type), `missing My Orders status resolver for ${type}`);
  }
});
