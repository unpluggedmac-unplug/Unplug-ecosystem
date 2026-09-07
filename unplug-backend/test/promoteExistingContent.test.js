const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const PROMOTE = path.join(ROOT, 'unplug-promote-existing.js');
const BUILD = path.join(ROOT, 'build.js');
const HIGHLIGHTS = path.join(__dirname, '..', 'src', 'routes', 'highlights.js');
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

test('Promote Existing Content is a first-class unified return journey for article or Directory content', () => {
  const src = read(PROMOTE);
  assert.match(src, /Promote Existing Content/);
  assert.match(src, /you have already published/i);
  assert.match(src, /shortcut\.id = 'promoteExistingNav'/);
  assert.match(src, /id="promoteExistingType"/);
  assert.match(src, /value="article">Published Article/);
  assert.match(src, /value="directory">Published Directory Profile/);
  assert.match(src, /id="promoteExistingItem"/);
  assert.match(src, /id="promoteExistingDuration"/);
  assert.doesNotMatch(src, /id="svcArtPick"/);
  assert.doesNotMatch(src, /id="svcProfPick"/);
});

test('only server-confirmed approved and live content is eligible for the promotion picker', () => {
  const ui = read(PROMOTE);
  const api = read(HIGHLIGHTS);

  // The browser consumes one authoritative eligibility response rather than
  // reconstructing publish/schedule rules from /articles/mine + /profiles/me.
  assert.match(ui, /api\('\/highlights\/eligible'\)/);
  assert.doesNotMatch(ui, /api\('\/articles\/mine'\)/);
  assert.doesNotMatch(ui, /api\('\/profiles\/me'\)/);
  assert.match(ui, /futureScheduledArticles/);
  assert.match(ui, /will appear here automatically once live/i);
  assert.match(ui, /must be approved and publicly live before it can be promoted/i);

  assert.match(api, /router\.get\('\/eligible', requireAuth/);
  assert.match(api, /status = 'approved'/);
  assert.match(api, /scheduled_for::date <= CURRENT_DATE/);
  assert.match(api, /directoryProfile: profile\.rows\[0\] \|\| null/);
});

test('promotion checkout reuses the selected existing id and never resubmits original content', () => {
  const src = read(PROMOTE);
  assert.match(src, /const targetType = typeSelect\.value/);
  assert.match(src, /const targetId = Number\(itemSelect\.value\)/);
  assert.match(src, /async function purchasePromotion\(/);
  assert.match(src, /api\('\/highlights',\s*\{\s*method:\s*'POST'/);
  assert.match(src, /targetType,\s*targetId,\s*durationDays/);
  assert.match(src, /api\('\/payments\/initiate',\s*\{\s*method:\s*'POST'/);
  assert.match(src, /linkedType:\s*'highlight'/);
  assert.match(src, /linkedId:\s*createdHighlightId/);
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
  assert.match(src, /if \(!sessionReady\(\)\) return false/);
  assert.match(src, /if \(!sessionReady\(\)\) \{/);
  assert.match(src, /const readyTimer = setInterval/);
  assert.match(src, /if \(sessionReady\(\)\) \{/);
  assert.match(src, /await loadData\(\)/);
});

test('database backstop refuses unpublished and future-scheduled paid highlight targets', () => {
  const sql = read(MIGRATION);
  assert.match(sql, /target_status <> 'approved'/);
  assert.match(sql, /target_scheduled_for > CURRENT_DATE/);
  assert.match(sql, /Only content already published and live can be highlighted/);
  assert.match(sql, /IF COALESCE\(NEW\.is_admin, false\) THEN/);
  assert.match(sql, /BEFORE INSERT OR UPDATE OF target_type, target_id, is_admin/);
});
