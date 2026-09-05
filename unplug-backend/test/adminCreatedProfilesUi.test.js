// Directory Profiles admin UI — the "Add a new listing" panel and the
// editor's "Delete listing" button. The real behaviour (POST/DELETE
// /admin/profiles, and the nullable-owner schema change) is covered by
// adminCreatedProfiles.test.js; this file only checks the admin dashboard
// wiring that calls those routes.
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

test('THE "ADD A NEW LISTING" FORM EXISTS, WITH THE THREE FIELDS profiles NEEDS AT CREATION', () => {
  const src = readAdmin();
  assert.match(src, /<h3>Add a new listing<\/h3>/);
  assert.match(src, /id="dpNewName"/);
  assert.match(src, /id="dpNewType"/);
  assert.match(src, /id="dpNewTier"/);
  assert.match(src, /id="dpNewCategory"/);
});

test('CREATING A LISTING POSTS TO /admin/profiles, THEN JUMPS STRAIGHT INTO THE EDITOR FOR IT', () => {
  const src = readAdmin();
  const idx = src.indexOf("getElementById('dpCreateBtn').addEventListener('click'");
  assert.ok(idx > -1);
  const body = src.slice(idx, src.indexOf('\n});', idx));
  assert.match(body, /api\('\/admin\/profiles', \{/);
  assert.match(body, /method: 'POST'/);
  assert.match(body, /dpLoadProfile\(data\.profile\.id, data\.profile\.slug\)/);
});

test('THE EDITOR HAS A DELETE BUTTON, GATED BEHIND A CONFIRM, WHICH CALLS DELETE /admin/profiles/:id', () => {
  const src = readAdmin();
  assert.match(src, /id="dpDeleteBtn"/);
  const idx = src.indexOf("getElementById('dpDeleteBtn').addEventListener('click'");
  assert.ok(idx > -1);
  const body = src.slice(idx, src.indexOf('\n});', idx));
  assert.match(body, /confirm\(/);
  assert.match(body, /method: 'DELETE'/);
  assert.match(body, /api\(`\/admin\/profiles\/\$\{DP_CURRENT\.id\}`/);
});
