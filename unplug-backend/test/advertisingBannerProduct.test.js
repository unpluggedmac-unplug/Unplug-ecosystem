// ADV-002/003: "don't sell a banner for 7 days, sell reach" — and once
// someone's interested, tell them where it actually appears, what to bring,
// and what happens after paying. The Advertising page had real audience
// numbers (mediaKitStats) and real pricing already, but nothing about
// placements, file requirements, start dates or approval — and its one CTA,
// "Advertise Here", pointed at the page it was already on.
//
// Website remediation punch-list (2026-09-03).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', '..', 'unplug-magazine.html');

function read() {
  assert.ok(fs.existsSync(FILE), 'unplug-magazine.html should exist');
  return fs.readFileSync(FILE, 'utf8').split('\r\n').join('\n');
}

test('THE PRODUCT DESCRIPTION COVERS FILE REQUIREMENTS, START DATE AND APPROVAL', () => {
  const src = read();
  const start = src.indexOf('Buy a Page Banner Directly');
  assert.ok(start > -1);
  const block = src.slice(start, start + 900);
  assert.match(block, /JPEG.*PNG.*WebP.*GIF/i, 'should state the accepted file formats');
  assert.match(block, /8MB/, 'should state the real file-size limit');
  assert.match(block, /start date/i, 'should mention the start date is chosen, not fixed');
  assert.match(block, /reviewed/i, 'should mention the approval step honestly');
});

test('PLACEMENTS ARE FETCHED FROM THE REAL BUY-FORM ENDPOINT, NOT A SECOND HARDCODED LIST', () => {
  const src = read();
  const start = src.indexOf('async function loadAdPlacements()');
  assert.ok(start > -1);
  const body = src.slice(start, start + 900);
  assert.match(body, /api\('\/ad-banners\/options'\)/,
    'should read the same endpoint the buy form itself uses, so the two can never disagree');
});

test('NO REPORTING IS CLAIMED — THERE ISN\'T ANY YET', () => {
  // The backend has no advertiser-facing impressions/click reporting.
  // Claiming one would be a promise the product can't keep.
  const src = read();
  const start = src.indexOf('Buy a Page Banner Directly');
  const block = src.slice(start, start + 900);
  assert.ok(!/report|analytics|dashboard/i.test(block),
    'should not promise reporting that does not exist');
});

test('THE CTA ACTUALLY GOES SOMEWHERE — NOT BACK TO THE SAME PAGE', () => {
  const src = read();
  const btnIdx = src.indexOf('id="advBuyBannerBtn"');
  assert.ok(btnIdx > -1);
  // The old "Advertise Here" button pointed data-page="brandplacement" while
  // already being ON brandplacement — a no-op. This one must not repeat that.
  const tag = src.slice(Math.max(0, btnIdx - 60), btnIdx + 60);
  assert.ok(!tag.includes('data-page="brandplacement"'), 'must not link back to the page it is already on');

  const wireIdx = src.indexOf("getElementById('advBuyBannerBtn')");
  assert.ok(wireIdx > -1);
  const wiring = src.slice(wireIdx, wireIdx + 200);
  assert.match(wiring, /goToMemberDashboard/, 'should route to where the banner is actually bought');
});
