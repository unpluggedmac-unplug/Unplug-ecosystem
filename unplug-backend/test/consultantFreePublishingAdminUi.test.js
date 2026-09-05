// Per-consultant free-publishing toggle — the admin dashboard UI.
//
// Static-source checks against unplug-admin-dashboard.html — the real
// behaviour (the PATCH route, publishesFree()/statusForNewSubmission(), and
// the real login-to-consumption path) is already covered by
// usersAdmin.test.js, freePublishing.test.js and
// consultantFreePublishingLogin.test.js.
//
// Run with:  npm test   (from unplug-backend/)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function readAdmin() {
  const file = path.join(__dirname, '..', '..', 'unplug-admin-dashboard.html');
  assert.ok(fs.existsSync(file));
  return fs.readFileSync(file, 'utf8').split('\r\n').join('\n');
}

test('EVERY ACCOUNT ROW HAS A FREE-PUBLISHING CHECKBOX, DEFAULTING TO THAT ACCOUNT\'S REAL SERVER VALUE', () => {
  const src = readAdmin();
  const idx = src.indexOf('function userRowHtml(u)');
  assert.ok(idx > -1);
  const body = src.slice(idx, src.indexOf('function toggleSuspendUser', idx));
  assert.match(body, /class="u-free-publishing"/);
  assert.match(body, /u\.free_publishing_enabled !== false \? ' checked' : ''/,
    'must reflect the server value per-account, not a hardcoded default');
});

test('THE LABEL IS HONEST THAT THIS ONLY MEANS ANYTHING FOR A CONSULTANT', () => {
  const src = readAdmin();
  const idx = src.indexOf('class="u-free-publishing"');
  const nearby = src.slice(idx, idx + 250);
  assert.match(nearby, /consultants only/i);
});

test('SAVING A ROW SENDS THE CHECKBOX\'S REAL STATE, EVERY TIME — NOT ONLY WHEN IT CHANGED', () => {
  const src = readAdmin();
  const idx = src.indexOf('async function saveUser(id)');
  assert.ok(idx > -1);
  const body = src.slice(idx, src.indexOf('\n}', idx));
  assert.match(body, /freePublishingEnabled: row\.querySelector\('\.u-free-publishing'\)\.checked/);
});

test('THE TOGGLE IS SENT UNCONDITIONALLY, UNLIKE ROLE — IT NEEDS NO "IS THIS EDITABLE" GUARD SINCE IT IS HARMLESS FOR ANY NON-CONSULTANT', () => {
  const src = readAdmin();
  const idx = src.indexOf('async function saveUser(id)');
  const body = src.slice(idx, src.indexOf('\n}', idx));
  // The role field is conditionally sent (only when its <select> isn't
  // disabled); the free-publishing checkbox has no such guard, since setting
  // it on a non-consultant account is a stored no-op, not a risk.
  const freePubLine = body.split('\n').find((l) => l.includes('freePublishingEnabled:'));
  assert.ok(freePubLine && !/if\s*\(/.test(freePubLine));
});
