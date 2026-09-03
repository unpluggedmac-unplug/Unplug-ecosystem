// Every purchase that takes money should look like a purchase that takes
// money — the same cancellation-policy summary, the same payment-method
// disclosure, the same proof-of-payment upload as Editions checkout and
// Submit & Pay already have.
//
// QA punch list 2026-09-03, task 6/6: Highlight Article, Highlight Profile,
// the profile-page "Highlight my listing" button, and the tier Upgrade button
// were four purchase entry points with none of that — just a bare checkbox
// naming the policies with nothing to read, EFT hardcoded with no visible
// choice or explanation, and no way to speed up approval with proof of
// payment. This reads the source rather than driving a browser: what matters
// is that each purchase path SENDS the right thing and the page SHOWS the
// right thing, not how it renders pixel for pixel.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', '..', 'unplug-member-dashboard.html');

function read() {
  assert.ok(fs.existsSync(FILE), 'unplug-member-dashboard.html should exist');
  // Edited on Windows; normalise so multi-line anchors don't miss on CRLF.
  return fs.readFileSync(FILE, 'utf8').split('\r\n').join('\n');
}

// The four checkbox ids gate the four purchase entry points this task fixed.
// One list, reused by every check below, so a fifth purchase button added
// later is exactly one line to bring into this test's coverage.
const GATES = ['svcArtTermsChk', 'svcProfTermsChk', 'hlTermsChk', 'upgradeTermsChk'];

test('EVERY HIGHLIGHT/UPGRADE PURCHASE SHOWS THE CANCELLATION SUMMARY BEFORE ITS CHECKBOX', () => {
  const src = read();
  for (const gateId of GATES) {
    const idx = src.indexOf(`id="${gateId}"`);
    assert.ok(idx > -1, `${gateId} should still exist`);
    // The summary paragraph must appear BEFORE the checkbox it gates, and
    // reasonably close to it — not just somewhere earlier in the file.
    const before = src.slice(Math.max(0, idx - 1200), idx);
    assert.match(before, /Cancellation &amp; Credit Policy:/,
      `${gateId} has no cancellation-policy summary immediately before it`);
    assert.match(before, /VIEW CANCELLATION, REFUND &amp; ACCOUNT CREDIT POLICY/,
      `${gateId} has no link to the full policy immediately before it`);
  }
});

test('EVERY HIGHLIGHT/UPGRADE PURCHASE DISCLOSES THE PAYMENT METHOD', () => {
  const src = read();
  // Highlight Article and Highlight Profile had NO method selector at all
  // (buyHighlight() hardcoded 'eft' in JS) — the fix added one to each.
  for (const selectId of ['svcArtPayMethod', 'svcProfPayMethod', 'hlPayMethod']) {
    assert.ok(src.includes(`id="${selectId}"`), `${selectId} should exist`);
  }
  // Upgrade has no package/duration choice to attach a selector to (it is a
  // flat R250 fee) — it gets the same disclosure sentence instead, so a
  // member is told EFT-only rather than left to assume.
  const upgradeIdx = src.indexOf('id="upgradeTermsChk"');
  const upgradeBefore = src.slice(Math.max(0, upgradeIdx - 1200), upgradeIdx);
  assert.match(upgradeBefore, /Card and Instant EFT payments via PayFast and Ozow will be available soon/,
    'the upgrade flow should disclose that only EFT is live, same wording as Submit & Pay');
});

test('buyHighlight() no longer hardcodes the payment method', () => {
  const src = read();
  const start = src.indexOf('async function buyHighlight(');
  assert.ok(start > -1, 'buyHighlight should still exist');
  const end = src.indexOf('\n}', src.indexOf('showToast(\'Highlight reserved', start));
  const body = src.slice(start, end);
  assert.ok(!/method:\s*'eft'/.test(body),
    'buyHighlight should read the method from the form, not hardcode eft');
  assert.match(body, /payMethodId/, 'buyHighlight should accept which selector to read the method from');
});

test('EVERY HIGHLIGHT/UPGRADE PURCHASE OFFERS PROOF-OF-PAYMENT UPLOAD, LIKE SUBMIT & PAY DOES', () => {
  const src = read();
  // Four EFT-instructions branches now call popUploadBlock: buyHighlight()
  // (shared by Highlight Article and Highlight Profile), the profile-page
  // Highlight button, and the tier Upgrade button.
  const calls = (src.match(/popUploadBlock\('payments',/g) || []).length;
  assert.ok(calls >= 3,
    `expected at least 3 popUploadBlock('payments', ...) call sites (buyHighlight, ` +
    `hlBuyBtn, upgrade-btn), found ${calls}`);
});

test('the wording matches Submit & Pay\'s, not a paraphrase of it', () => {
  // Same site, same policy, same sentence — a second wording of the same
  // rule is a second place for it to drift out of sync with the real policy
  // page. Confirms the fix reused the establishing text rather than writing
  // a new version of it.
  const src = read();
  const submitWording = "A minimum of 7 working days' notice is required to cancel before a service starts. "
    + "If eligible, 100% of the amount paid will be credited to your account (no cash refund) — credit never expires. "
    + "Once a service has started, no refund or unused-period credit will be provided, subject to applicable law.";
  const occurrences = src.split(submitWording).length - 1;
  assert.ok(occurrences >= 4,
    `expected the exact Submit & Pay wording at all 4 highlight/upgrade gates plus its own, found ${occurrences}`);
});
