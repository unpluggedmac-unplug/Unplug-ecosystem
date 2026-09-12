const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', '..');
const dashboard = fs.readFileSync(path.join(root, 'unplug-admin-dashboard.html'), 'utf8');
const agreements = fs.readFileSync(path.join(root, 'unplug-agreements-admin.html'), 'utf8');
const growth = fs.readFileSync(path.join(root, 'unplug-growth-applications-admin.html'), 'utf8');

test('standalone admin workspaces reuse the Control Centre admin session', () => {
  assert.match(dashboard, /const ADMIN_TOKEN_KEY = 'unplug_admin_token'/);
  assert.match(agreements, /const TOKEN=localStorage\.getItem\('unplug_admin_token'\)/);
  assert.match(growth, /const ADMIN_TOKEN=localStorage\.getItem\('unplug_admin_token'\)/);
});

test('Growth admin verifies the scoped admin token without adopting member auth', () => {
  assert.match(growth, /await api\('\/auth\/me'\)/);
  assert.doesNotMatch(growth, /UnplugAPI\.restoreSession/);
  assert.doesNotMatch(growth, /localStorage\.getItem\('unplug_auth_token'\)/);
});
