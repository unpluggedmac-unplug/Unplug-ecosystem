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

test('Promote Existing Content is a first-class return journey for article or Directory content', () => {
  const src = read(PROMOTE);
  assert.match(src, /Promote Existing Content/);
  assert.match(src, /you have already published/i);
  assert.match(src, /shortcut\.id = 'promoteExistingNav'/);
  assert.match(src, /id="promoteExistingType"/);
  assert.match(src, /value="article">Published Article/);
  assert.match(src, /value="directory">Published Directory Profile/);
  assert.match(src, /id="svcArtPick"/);
  assert.match(src, /id="svcProfPick"/);
});

test('only content already approved and live is eligible for the promotion picker', () => {
  const src = read(PROMOTE);
  assert.match(src, /api\('\/articles\/mine'\)/);
  assert.match(src, /article\.status === 'approved'/);
  assert.match(src, /article\.scheduled_for/);
  assert.match(src, /String\(article\.scheduled_for\)\.slice\(0, 10\) <= today/);
  assert.match(src, /will appear here once live/i);
  assert.match(src, /api\('\/profiles\/me'\)/);
  assert.match(src, /profile\.status === 'approved'/);
  assert.match(src, /must be approved and live before it can be promoted/i);
});

test('promotion checkout reuses selected existing ids and never resubmits original content', () => {
  const src = read(PROMOTE);
  assert.match(src, /targetType:\s*'article'/);
  assert.match(src, /targetId:\s*Number\(document\.getElementById\('svcArtPick'\)\.value\)/);
  assert.match(src, /targetType:\s*'directory'/);
  assert.match(src, /targetId:\s*Number\(document\.getElementById\('svcProfPick'\)\.value\)/);
  assert.match(src, /async function purchasePromotion\(/);
  assert.match(src, /api\('\/highlights',\s*\{\s*method:\s*'POST'/);
  assert.match(src, /api\('\/payments\/initiate',\s*\{\s*method:\s*'POST'/);
  assert.match(src, /linkedType:\s*'highlight'/);
  assert.match(src, /linkedId:\s*created\.highlight\.id/);
  assert.ok(!/api\('\/articles',\s*\{\s*method:\s*'POST'/.test(src));
  assert.ok(!/api\('\/profiles',\s*\{\s*method:\s*'POST'/.test(src));
});

test('promotion checkout has normal Unplug voucher, account credit and server-side quote parity', () => {
  const src = read(PROMOTE);
  assert.match(src, /api\('\/payments\/quote'/);
  assert.match(src, /api\('\/payments\/credit'\)/);
  assert.match(src, /voucherCode:/);
  assert.match(src, /useCredit:/);
  assert.match(src, /creditApplied/);
  assert.match(src, /amountToPay/);
  assert.match(src, /voucherError/);
  assert.match(src, /popUploadBlock\('payments'/);
});

test('promotion module waits for the restored authenticated session before protected API calls', () => {
  const src = read(PROMOTE);
  assert.match(src, /const sessionReady = \(\) => typeof AUTH_TOKEN !== 'undefined' && !!AUTH_TOKEN/);
  assert.match(src, /if \(sessionReady\(\)\) refreshQuote/);
  assert.match(src, /if \(!sessionReady\(\)\) return false/);
});

test('database backstop refuses unpublished and future-scheduled paid highlight targets', () => {
  const sql = read(MIGRATION);
  assert.match(sql, /target_status <> 'approved'/);
  assert.match(sql, /target_scheduled_for > CURRENT_DATE/);
  assert.match(sql, /Only content already published and live can be highlighted/);
  assert.match(sql, /IF COALESCE\(NEW\.is_admin, false\) THEN/);
  assert.match(sql, /BEFORE INSERT OR UPDATE OF target_type, target_id, is_admin/);
});
