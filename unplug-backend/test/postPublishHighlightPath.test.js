// Regression coverage for the member pathway requested during the Control Centre audit:
// a member must be able to return AFTER publishing an article/directory profile,
// choose that existing content, and buy a Highlight without submitting the content again.
//
// This is intentionally a source-contract test. It protects the customer-facing path
// and the backend ownership/payment linkage without needing production credentials or
// making a real payment during CI.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const DASHBOARD = path.join(__dirname, '..', '..', 'unplug-member-dashboard.html');
const HIGHLIGHTS_ROUTE = path.join(__dirname, '..', 'src', 'routes', 'highlights.js');

function read(file) {
  assert.ok(fs.existsSync(file), `${path.basename(file)} should exist`);
  return fs.readFileSync(file, 'utf8').split('\r\n').join('\n');
}

test('member dashboard exposes a separate Highlight Services path for already-published content', () => {
  const src = read(DASHBOARD);
  assert.match(src, /id="hlServicesCard"/);
  assert.match(src, /Boost the visibility of something you've already published/);
  assert.match(src, /Highlight Article/);
  assert.match(src, /Highlight Profile/);
});

test('article highlight picker is populated from the member own published articles', () => {
  const src = read(DASHBOARD);
  assert.match(src, /api\('\/articles\/mine'\)/);
  assert.match(src, /filter\(\(a\) => a\.status === 'approved'\)/);
  assert.match(src, /id="svcArtPick"/);
  assert.match(src, /targetType:\s*'article'/);
  assert.match(src, /targetId:\s*Number\(document\.getElementById\('svcArtPick'\)\.value\)/);
});

test('directory highlight reuses the member existing profile instead of resubmitting it', () => {
  const src = read(DASHBOARD);
  assert.match(src, /api\('\/profiles\/me'\)/);
  assert.match(src, /MY_PROFILE_ID\s*=\s*p\.id/);
  assert.match(src, /targetType:\s*'directory'/);
  assert.match(src, /targetId:\s*MY_PROFILE_ID/);
});

test('later highlight purchase creates only a highlight request then links normal payment checkout to it', () => {
  const src = read(DASHBOARD);
  const start = src.indexOf('async function buyHighlight(');
  assert.ok(start > -1, 'buyHighlight should exist');
  const body = src.slice(start, start + 7000);
  assert.match(body, /api\('\/highlights',\s*\{\s*method:\s*'POST'/);
  assert.match(body, /api\('\/payments\/initiate',\s*\{\s*method:\s*'POST'/);
  assert.match(body, /linkedType:\s*'highlight'/);
  assert.match(body, /linkedId:\s*created\.highlight\.id/);
  assert.ok(!/api\('\/articles',\s*\{\s*method:\s*'POST'/.test(body),
    'highlight checkout must not create/resubmit an article');
  assert.ok(!/api\('\/profiles',\s*\{\s*method:\s*'POST'/.test(body),
    'highlight checkout must not create/resubmit a directory profile');
});

test('backend highlight purchase requires authentication and enforces ownership', () => {
  const src = read(HIGHLIGHTS_ROUTE);
  assert.match(src, /router\.post\('\/',\s*requireAuth/);
  assert.match(src, /You can only highlight your own content\./);
  // The hardened route now assigns ownerCheck.rows[0] to `target` because the
  // same row also carries approval/live eligibility. Keep the guard semantic:
  // an ownership comparison against req.user.id must still be present.
  assert.match(src, /const\s+target\s*=\s*ownerCheck\.rows\[0\]/);
  assert.match(src, /target\.owner_id\s*!==\s*req\.user\.id/);
});
