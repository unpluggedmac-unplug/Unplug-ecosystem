const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Regression guard: the account-creation API can succeed even when verification
// email delivery is simulated or unavailable, so the browser must reflect the
// backend emailSent result instead of always claiming that a message was sent.
test('signup UI does not claim a verification email was sent when delivery was simulated or failed', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'unplug-member-dashboard.html'), 'utf8');
  assert.match(html, /const registration = await api\('\/auth\/register'/);
  assert.match(html, /registration\.emailSent === false/);
  assert.match(html, /verification email could not be delivered/);
});

// Staging signup, login and password reset must all inherit the isolated
// Cloudflare runtime API. A hidden production default here previously caused
// signup to fail before the request ever reached the staging backend.
test('staging auth controls are pinned to the runtime API', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'unplug-member-dashboard.html'), 'utf8');
  const runtime = fs.readFileSync(path.join(__dirname, '..', '..', 'functions', 'runtime-config.js'), 'utf8');

  assert.match(html, /const RUNTIME_API_BASE = \(window\.UNPLUG_RUNTIME_API \|\| ""\)/);
  assert.match(html, /\['apiBaseInput', 'registerApiBaseInput', 'forgotApiBaseInput'\]/);
  assert.match(runtime, /\["apiBaseInput","registerApiBaseInput","forgotApiBaseInput"\]/);
});
