'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const page = fs.readFileSync(path.join(ROOT, 'unplug-member-dashboard.html'), 'utf8');
const script = fs.readFileSync(path.join(ROOT, 'media', 'scripts', 'member-dashboard-service-shortcuts.js'), 'utf8');
const loader = fs.readFileSync(path.join(ROOT, 'media', 'scripts', 'member-dashboard-control-centre-loader.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'media', 'styles', 'member-dashboard-service-shortcuts.css'), 'utf8');
const runtime = fs.readFileSync(path.join(ROOT, 'functions', 'runtime-config.js'), 'utf8');

test('service shortcut layer parses and is Member Dashboard only', () => {
  assert.doesNotThrow(() => new Function(script));
  assert.match(script, /if\(!\/unplug-member-dashboard\/i\.test\(location\.pathname\)\)return/);
  assert.match(runtime, /member-dashboard-control-centre-loader\.js\?v=/);
  assert.match(loader, /member-dashboard-service-shortcuts\.js\?v=/);
});

test('service shortcuts derive from the real rendered service catalogue', () => {
  assert.match(page, /id="msServicesGrid"/);
  assert.match(page, /className='ms-service'/);
  assert.match(script, /#msServicesGrid \.ms-service/);
  assert.match(script, /q\('\.t',card\)/);
  assert.doesNotMatch(script, /fetch\(/, 'shortcut layer must not create a second service API');
});

test('services navigation follows the approved compact pattern', () => {
  assert.match(script, /View All Services/);
  assert.match(script, /Favourite Services/);
  assert.match(script, /Recent Services/);
  assert.match(script, /data-node="g-services"/);
  assert.match(script, /data-id="browse-services"/);
});

test('favourites and recents persist locally with sensible limits', () => {
  assert.match(script, /unplug_member_cc_service_favourites_v1/);
  assert.match(script, /unplug_member_cc_service_recent_v1/);
  assert.match(script, /slice\(0,5\)/);
  assert.match(script, /slice\(0,8\)/);
  assert.match(script, /recordRecent/);
});

test('favourite management is explicit rather than adding invalid nested buttons to service cards', () => {
  assert.match(script, /Manage Favourite Services/);
  assert.match(script, /type="checkbox"/);
  assert.match(script, /Save favourites/);
  assert.doesNotMatch(script, /ms-service[^\n]{0,120}appendChild\([^\n]*button/i);
});

test('service shortcut dialogs are accessible, dismissible and clean up global handlers', () => {
  assert.match(script, /role="dialog"/);
  assert.match(script, /aria-modal="true"/);
  assert.match(script, /aria-labelledby/);
  assert.match(script, /aria-label="Close"/);
  assert.match(script, /Escape/);
  assert.match(script, /__ccEscapeHandler/);
  assert.match(script, /removeEventListener\('keydown',modal\.__ccEscapeHandler,true\)/);
  assert.match(css, /:focus-visible/);
});

test('service shortcut UI is responsive and reuses Unplug tokens', () => {
  assert.match(css, /@media\(max-width:560px\)/);
  for (const token of ['var(--paper-line)', 'var(--ink)', 'var(--red)', 'var(--paper)']) {
    assert.ok(css.includes(token), `missing shared token: ${token}`);
  }
  assert.doesNotMatch(css, /#[0-9a-fA-F]{6}/);
});
