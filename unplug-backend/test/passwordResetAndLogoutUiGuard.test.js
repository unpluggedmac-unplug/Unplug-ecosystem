// Staging release guard for the logout and six-digit password-reset fixes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const auth = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'auth.js'), 'utf8');
const rate = fs.readFileSync(path.join(__dirname, '..', 'src', 'middleware', 'rateLimit.js'), 'utf8');
const ui = fs.readFileSync(path.join(ROOT, 'unplug-member-dashboard.html'), 'utf8');

test('password reset uses a short six-digit code with guessing protection', () => {
  assert.match(auth, /crypto\.randomInt\(100000, 1000000\)/);
  assert.match(auth, /Your 6-digit reset code is:/);
  assert.match(auth, /router\.post\('\/reset-password', resetCodeLimiter/);
  assert.match(auth, /lower\(u\.email\) = lower\(\$2\)/);
  assert.match(rate, /const resetCodeLimiter = rateLimit\(/);
  assert.match(rate, /max: 8/);
  assert.match(ui, /id="resetToken"[^>]*maxlength="6"[^>]*pattern="\[0-9\]\{6\}"/);
  assert.match(ui, /JSON\.stringify\(\{ email, code, newPassword \}\)/);
});

test('member logout clears the session and returns directly to Sign In', () => {
  assert.match(ui, /function memberLogoutToSignIn\(\)/);
  assert.match(ui, /AUTH_TOKEN = null;/);
  assert.match(ui, /localStorage\.removeItem\('unplug_auth_token'\);[\s\S]{0,500}location\.replace\(target\)/);
  assert.match(ui, /location\.pathname \+ '\?signin=1'/);
  assert.match(ui, /startupParams\.get\('signin'\) === '1'/);
  assert.match(ui, /history\.replaceState\(\{\}, '', location\.pathname\);[\s\S]{0,120}showCard\('loginCard'\)/);
  assert.doesNotMatch(ui, /removeItem\('unplug_auth_token'\);\s*location\.reload\(\)/);
  assert.match(ui, /logoutBtnTop[\s\S]{0,300}memberLogoutToSignIn/);
  assert.match(ui, /logoutBtn'\)\.addEventListener\('click', memberLogoutToSignIn\)/);
  assert.match(ui, /msLogout[\s\S]{0,500}memberLogoutToSignIn/);
});
