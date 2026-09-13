'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

test('Growth V2 Cloudflare build injects staging runtime isolation before page code', () => {
  const builder = fs.readFileSync(path.join(ROOT, 'scripts', 'build-growth-pages.js'), 'utf8');
  assert.match(builder, /RUNTIME_ISOLATED_V2/);
  assert.match(builder, /unplug-growth-application-v2\.html/);
  assert.match(builder, /unplug-growth-applications-admin-v2\.html/);
  assert.match(builder, /src=\\?"\/runtime-config\\?"/);
  assert.match(builder, /src=\\?"\/unplug-shared\.js\\?"/);
  assert.match(builder, /injectRuntimeIsolation\(file, html\)/);
  assert.match(builder, /runtime isolation injection failed/i);
  assert.match(builder, /Packaged Growth V2 page lost runtime isolation/i);
});

test('Growth V2 source still resolves API exclusively through runtime value before fallback', () => {
  for (const file of ['unplug-growth-application-v2.html', 'unplug-growth-applications-admin-v2.html']) {
    const page = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.match(page, /window\.UNPLUG_RUNTIME_API/);
  }
});

test('Control Centre exposes one canonical Growth Applications entry routed to V2 while retaining legacy rollback files', () => {
  const edge = fs.readFileSync(path.join(ROOT, 'functions', '[[path]].js'), 'utf8');
  const integration = fs.readFileSync(path.join(ROOT, 'growth-integration.js'), 'utf8');

  assert.match(edge, /unplug-growth-applications-admin-v2/);
  assert.match(edge, /setInnerContent\('Growth Applications'\)/);
  assert.match(edge, /data-unplug-growth-admin-link/);
  assert.match(edge, /element\.remove\(\)/);
  assert.match(edge, /unplug-admin-dashboard\(\?:\\\.html\)\?/);

  assert.match(integration, /const ADMIN_V2 = '\/unplug-growth-applications-admin-v2\.html'/);
  assert.match(integration, /legacySelector/);
  assert.match(integration, /existing\.forEach\(\(a\) => a\.remove\(\)\)/);
  assert.match(integration, /keep\.textContent = 'Growth Applications'/);

  assert.equal(fs.existsSync(path.join(ROOT, 'unplug-growth-applications-admin.html')), true);
  assert.equal(fs.existsSync(path.join(ROOT, 'unplug-growth-applications-admin-v2.html')), true);
});
