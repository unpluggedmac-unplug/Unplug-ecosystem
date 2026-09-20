'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('profile interaction notifications use the shared preference-aware member notifier', () => {
  const src = read('src/routes/interactions.js');
  assert.match(src, /const \{ notifyMember \} = require\('\.\.\/utils\/memberNotify'\)/);
  assert.match(src, /type: 'profile_interaction'/);
  assert.match(src, /subject: 'Profile activity on Unplug'/);
  assert.match(src, /deferEmail: true/);
  assert.doesNotMatch(
    src.slice(src.indexOf('async function notifyProfileOwner'), src.indexOf('// GET /interactions/', src.indexOf('async function notifyProfileOwner'))),
    /INSERT INTO notifications/
  );
});

test('follow and unfollow add email only when the relationship really changes', () => {
  const src = read('src/routes/follows.js');
  assert.match(src, /notifyMemberEmailAsync/);
  assert.match(src, /if \(result\.rows\[0\]\.followed\)[\s\S]*emailFollowUpdateAsync\(req\.user\.id, followedId, 'followed'\)/);
  assert.match(src, /SELECT unfollow_member\(\$1, \$2\) AS unfollowed/);
  assert.match(src, /if \(result\.rows\[0\]\.unfollowed\)[\s\S]*emailFollowUpdateAsync\(req\.user\.id, followedId, 'unfollowed'\)/);
});

test('email-only member notification respects preferences and cannot duplicate the in-app row', () => {
  const src = read('src/utils/memberNotify.js');
  const start = src.indexOf('async function notifyMemberEmail(');
  const end = src.indexOf('function notifyMemberEmailAsync', start);
  assert.ok(start >= 0 && end > start);
  const fn = src.slice(start, end);
  assert.match(fn, /const prefs = await preferencesFor\(userId\)/);
  assert.match(fn, /if \(!prefs\.email\)/);
  assert.match(fn, /sendMemberEmail\(userId, email\)/);
  assert.doesNotMatch(fn, /INSERT INTO notifications/);
});

test('deferred community email never blocks the already-committed in-app notification', () => {
  const src = read('src/utils/memberNotify.js');
  assert.match(src, /if \(deferEmail\)[\s\S]*sendMemberEmail\(userId, email\)\.catch/);
  assert.match(src, /return \{ sent: web \|\| mailed \|\| emailQueued, web, mailed, emailQueued \}/);
});
