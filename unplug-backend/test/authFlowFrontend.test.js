const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const patch = fs.readFileSync(path.join(ROOT, 'media', 'scripts', 'member-dashboard-auth-flow-fix.js'), 'utf8');
const loader = fs.readFileSync(path.join(ROOT, 'media', 'scripts', 'member-dashboard-control-centre-loader.js'), 'utf8');

test('member dashboard loads the auth-flow repair after the existing dashboard scripts', () => {
  const services = loader.indexOf('member-dashboard-service-shortcuts.js?v=');
  const auth = loader.indexOf('member-dashboard-auth-flow-fix.js?v=');
  assert.ok(services > -1 && auth > services, 'auth repair must load after the existing dashboard scripts');
});

test('reset code UI is constrained to six numeric digits and submits the requesting email', () => {
  assert.match(patch, /resetCode\.maxLength=6/);
  assert.match(patch, /resetCode\.inputMode='numeric'/);
  assert.match(patch, /resetCode\.value\.replace\(\/\\D\/g,''\)\.slice\(0,6\)/);
  assert.match(patch, /JSON\.stringify\(\{email:email,code:code,newPassword:password\}\)/);
});

test('sign-in is presented as email or cell number and hides developer-only API wording', () => {
  assert.match(patch, /Email or Cell Number/);
  assert.match(patch, /Email address or cell number/);
  assert.match(patch, /Is the API running at that URL\?/);
  assert.match(patch, /replace\(suffix,''\)/);
});

test('repeated unfinished signup is routed back to verification instead of becoming a dead end', () => {
  assert.match(patch, /still needs email verification/);
  assert.match(patch, /navigateCard\('verifyCard'\)/);
  assert.match(patch, /fresh 6-digit code/);
});
