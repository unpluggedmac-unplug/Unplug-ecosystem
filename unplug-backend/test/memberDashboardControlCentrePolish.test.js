'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const page = fs.readFileSync(path.join(ROOT, 'unplug-member-dashboard.html'), 'utf8');
const polish = fs.readFileSync(path.join(ROOT, 'media', 'scripts', 'member-dashboard-control-centre-polish.js'), 'utf8');
const polishCss = fs.readFileSync(path.join(ROOT, 'media', 'styles', 'member-dashboard-control-centre-polish.css'), 'utf8');

function occurs(text, needle) {
  return text.split(needle).length - 1;
}

test('account convenience shortcuts reuse real Account Settings controls', () => {
  assert.match(page, /id="twoFactorContent"/);
  assert.match(page, /id="notifPrefsContent"/);
  assert.match(polish, /Login & Security/);
  assert.match(polish, /Notification Preferences/);
  assert.match(polish, /#twoFactorContent/);
  assert.match(polish, /#notifPrefsContent/);
  assert.match(polish, /data-account-shortcut/);
  assert.doesNotMatch(polish, /fetch\(/, 'shortcuts must reuse the existing member workspace instead of calling a second API');
});

test('account shortcuts are discoverable through Member Dashboard search', () => {
  for (const term of ['login', 'security', 'password', 'two[- ]?factor', 'communication', 'preference', 'notifications?', 'email']) {
    assert.ok(polish.includes(term), `missing search alias: ${term}`);
  }
  assert.match(polish, /data-polish-search/);
});

test('polish layer is additive and idempotent', () => {
  assert.match(polish, /if\(window\.__unplugMemberCCPolish\)return/);
  assert.match(polish, /if\(!\/unplug-member-dashboard\/i\.test\(location\.pathname\)\)return/);
  assert.match(polish, /if\(!q\('\[data-node="login-security"\]'/);
  assert.match(polish, /if\(!q\('\[data-node="communication-preferences"\]'/);
  assert.match(polish, /if\(scheduled\)return/);
  assert.equal(occurs(polish, "new MutationObserver"), 1, 'there should be one controlled observer in the polish layer');
});

test('polish observer ignores attributes it writes for accessibility', () => {
  assert.match(polish, /attributeFilter:\['class','hidden','style'\]/);
  assert.doesNotMatch(polish, /attributeFilter:[^\n]*aria-/);
  assert.match(polish, /function txt\(el,value\).*textContent!==value/s);
});

test('secondary workspaces receive one consistent page header without duplicating backend data', () => {
  assert.match(polish, /var PAGE_META=/);
  assert.match(polish, /function syncPageHeader\(/);
  assert.match(polish, /data-cc-page-head/);
  assert.match(polish, /MEMBER DASHBOARD/);
  assert.match(polish, /function pageStatus\(/);
  assert.match(polish, /My Directory Profile/);
  assert.match(polish, /My Profile/);
  assert.match(polish, /My Score & Level/);
  assert.match(polish, /Notification Preferences/);
  assert.match(polishCss, /cc-member-page-head/);
  assert.match(polishCss, /cc-member-page-status/);
  assert.doesNotMatch(polish, /fetch\(/, 'page headers must describe already-rendered state rather than create another data source');
});

test('profile checklist is derived from existing completion output', () => {
  assert.match(page, /id="muCompletionPct"/);
  assert.match(page, /id="muCompletionTodo"/);
  assert.match(polish, /Still to do:/);
  assert.match(polish, /muCompletionPct/);
  assert.match(polish, /muCompletionTodo/);
  assert.match(polishCss, /cc-home-profile-list/);
});

test('the member progress bridge remains a navigational layer, not a second growth engine', () => {
  for (const step of ['Identity', 'Participate', 'Grow', 'Opportunities']) {
    assert.ok(polish.includes(step), `missing progress step: ${step}`);
  }
  assert.match(polish, /unplugScore/);
  assert.match(polish, /unplugStatusBadge/);
  assert.match(polish, /growthAvailable/);
  assert.doesNotMatch(polish, /\/growth-application\/v2\/applications/);
});

test('polish remains responsive and keyboard visible', () => {
  assert.match(polishCss, /@media\(max-width:760px\)/);
  assert.match(polishCss, /@media\(max-width:500px\)/);
  assert.match(polishCss, /:focus-visible/);
  assert.match(polish, /Escape/);
});
