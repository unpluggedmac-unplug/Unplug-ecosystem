const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function memberDashboardHtml() {
  return fs.readFileSync(path.join(__dirname, '..', '..', 'unplug-member-dashboard.html'), 'utf8');
}

// Regression guard: the account-creation API can succeed even when verification
// email delivery is simulated or unavailable, so the browser must reflect the
// backend emailSent result instead of always claiming that a message was sent.
test('signup UI does not claim a verification email was sent when delivery was simulated or failed', () => {
  const html = memberDashboardHtml();
  assert.match(html, /const registration = await api\('\/auth\/register'/);
  assert.match(html, /registration\.emailSent === false/);
  assert.match(html, /verification email could not be delivered/);
});

// Staging must never let its hidden auth controls reset the API base to the
// production backend. The environment runtime config takes priority and is
// copied into signup, login and password-reset controls before they are used.
test('member auth controls inherit the runtime API base instead of production', () => {
  const html = memberDashboardHtml();

  assert.doesNotMatch(html, /id="registerApiBaseInput" value="https:\/\/unplug-ecosystem\.onrender\.com"/);
  assert.doesNotMatch(html, /id="apiBaseInput" value="https:\/\/unplug-ecosystem\.onrender\.com"/);
  assert.doesNotMatch(html, /id="forgotApiBaseInput" value="https:\/\/unplug-ecosystem\.onrender\.com"/);

  assert.match(html, /const RUNTIME_API_BASE = \(window\.UNPLUG_RUNTIME_API \|\| ""\)\.replace/);
  assert.match(html, /let API_BASE = RUNTIME_API_BASE \|\| localStorage\.getItem\("unplug_api_base"\) \|\| LIVE_API_BASE/);
  assert.match(html, /\['apiBaseInput', 'registerApiBaseInput', 'forgotApiBaseInput'\]/);
});
