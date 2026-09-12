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
