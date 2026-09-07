const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('signup UI does not claim a verification email was sent when delivery was simulated or failed', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'unplug-member-dashboard.html'), 'utf8');
  assert.match(html, /const registration = await api\('\/auth\/register'/);
  assert.match(html, /registration\.emailSent === false/);
  assert.match(html, /verification email could not be delivered/);
});
