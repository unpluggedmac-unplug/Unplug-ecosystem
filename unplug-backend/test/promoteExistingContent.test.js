const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const PROMOTE = path.join(ROOT, 'unplug-promote-existing.js');
const BUILD = path.join(ROOT, 'build.js');
const MIGRATION = path.join(__dirname, '..', 'db', 'migrations', '188_highlight_published_targets_only.sql');

function read(file) {
  assert.ok(fs.existsSync(file), `${path.basename(file)} should exist`);
  return fs.readFileSync(file, 'utf8').split('\r\n').join('\n');
}

test('member build injects the central Promote Existing Content module only into the member dashboard', () => {
  const build = read(BUILD);
  assert.match(build, /'unplug-promote-existing\.js'/);
  assert.match(build, /file === 'unplug-member-dashboard\.html'/);
  assert.match(build, /report\.moduleMap\['unplug-promote-existing\.js'\]/);
});

test('Promote Existing Content lets the member choose an existing article or Directory profile', () => {
  const src = read(PROMOTE);
  assert.match(src, /Promote Existing Content/);
  assert.match(src, /you have already published/i);
  assert.match(src, /id="promoteExistingType"/);
  assert.match(src, /value="article">Published Article/);
  assert.match(src, /value="directory">Published Directory Profile/);
  assert.match(src, /id="svcArtPick"/);
  assert.match(src, /id="svcProfPick"/);
});

test('only already-approved member content is eligible for the promotion picker', () => {
  const src = read(PROMOTE);
  assert.match(src, /api\('\/articles\/mine'\)/);
  assert.match(src, /filter\(\(article\) => article\.status === 'approved'\)/);
  assert.match(src, /api\('\/profiles\/me'\)/);
  assert.match(src, /profile\.status === 'approved'/);
  assert.match(src, /must be approved and live before it can be promoted/i);
});

test('promotion checkout reuses the selected existing ids and never resubmits the original content', () => {
  const src = read(PROMOTE);
  assert.match(src, /targetType:\s*'article'/);
  assert.match(src, /targetId:\s*Number\(document\.getElementById\('svcArtPick'\)\.value\)/);
  assert.match(src, /targetType:\s*'directory'/);
  assert.match(src, /targetId:\s*Number\(document\.getElementById\('svcProfPick'\)\.value\)/);
  assert.match(src, /buyHighlight\(/);
  assert.ok(!/api\('\/articles',\s*\{\s*method:\s*'POST'/.test(src));
  assert.ok(!/api\('\/profiles',\s*\{\s*method:\s*'POST'/.test(src));
});

test('database backstop refuses paid highlights for unpublished content', () => {
  const sql = read(MIGRATION);
  assert.match(sql, /target_status <> 'approved'/);
  assert.match(sql, /Only published content can be highlighted/);
  assert.match(sql, /IF COALESCE\(NEW\.is_admin, false\) THEN/);
  assert.match(sql, /BEFORE INSERT OR UPDATE OF target_type, target_id, is_admin/);
});
