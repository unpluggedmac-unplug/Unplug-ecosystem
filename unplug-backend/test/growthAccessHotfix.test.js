'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('member Growth workspace keeps image-spec loading in application scope', () => {
  const page = read('unplug-growth-application-v2.html');
  const helper = page.indexOf('async function loadImageSpecs()');
  const renderer = page.indexOf('function renderField(field)');
  const loader = page.indexOf('async function loadApps(selectId)');
  assert.ok(helper > 0, 'image-spec helper must exist');
  assert.ok(helper < loader, 'loadImageSpecs must be declared before loadApps calls it');
  assert.ok(helper < renderer, 'loadImageSpecs must not be nested inside renderField');
  assert.match(page, /try\{await loadImageSpecs\(\);const data=await api\('\/growth-application\/v2\/applications'\)/);
});

test('admin Growth workspace uses the Control Centre session and opens builder deep links', () => {
  const page = read('unplug-growth-applications-admin-v2.html');
  assert.match(page, /ADMIN_TOKEN_KEYS=\['unplug_admin_token','adminAccessToken','accessToken'\]/);
  assert.doesNotMatch(page, /function token\(\)\{try\{return localStorage\.getItem\('unplug_auth_token'\)/);
  assert.match(page, /query\.get\('tab'\)\|\|query\.get\('view'\)/);
  assert.match(page, /selectTab\(S\.tab\)/);
});

test('Control Centre Growth navigation targets the editable V2 master builder', () => {
  const hierarchy = read('media/scripts/admin-control-centre-hierarchy.js');
  const growthHelper = hierarchy.slice(hierarchy.indexOf('function growthHref'), hierarchy.indexOf('var model'));
  assert.match(growthHelper, /unplug-growth-applications-admin-v2\.html/);
  assert.doesNotMatch(growthHelper, /unplug-growth-applications-admin\.html'/);
  assert.match(hierarchy, /growthHref\(\{ tab: 'builder' \}\)/);
  assert.match(hierarchy, /Master Form Builder/);
});
