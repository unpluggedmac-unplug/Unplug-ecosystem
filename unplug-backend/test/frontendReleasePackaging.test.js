'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
function read(...parts) { return fs.readFileSync(path.join(ROOT, ...parts), 'utf8'); }

test('production build packages Agreement, Growth and explicit not-found pages', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.scripts.build, /build-release-pages\.js/);
  assert.match(pkg.scripts.build, /build-growth-pages\.js/);

  const releaseBuilder = read('scripts', 'build-release-pages.js');
  for (const page of [
    'unplug-agreement.html',
    'unplug-agreements-admin.html',
    '404.html',
    'not-found.html',
  ]) {
    assert.match(releaseBuilder, new RegExp(page.replace('.', '\\.')));
    assert.equal(fs.existsSync(path.join(ROOT, page)), true, `${page} must exist at source`);
  }
});

test('Cloudflare has a real 404 surface so catch-all redirect logic can observe misses', () => {
  const redirects = read('_redirects');
  const catchAll = read('functions', '[[path]].js');
  const fourOhFour = read('404.html');
  const notFound = read('not-found.html');

  assert.match(redirects, /\/not-found\.html\s+404/);
  assert.match(catchAll, /response\.status !== 404/);
  assert.match(fourOhFour, /Page not found \| Unplug Magazine/);
  assert.match(notFound, /Page not found \| Unplug Magazine/);
});
