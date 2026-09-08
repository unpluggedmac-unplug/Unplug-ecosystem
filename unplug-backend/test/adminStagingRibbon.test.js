const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const admin = fs.readFileSync(path.join(ROOT, 'unplug-admin-dashboard.html'), 'utf8');

test('admin dashboard visibly marks staging and preview environments', () => {
  assert.match(admin, /<script src="\/runtime-config"><\/script>/);
  assert.match(admin, /\^\(staging\|preview\)\$/i);
  assert.match(admin, /id = 'unplugEnvironmentRibbon'/);
  assert.match(admin, /UNPLUG STAGING/);
  assert.match(admin, /STAGING — API NOT CONFIGURED/);
});
