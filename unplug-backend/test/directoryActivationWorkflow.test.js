// DIR-003: explain the Directory activation workflow, matching the real
// code — not the original spec's six-step diagram, which includes a Preview
// screen that was never built and a separate Reference Number step that is
// really part of paying, not its own screen.
//
// Verified against the actual route logic before writing this copy:
//   POST /profiles            -> status 'awaiting_payment'
//   payment confirmed         -> status 'pending'      (payments.js applyPaymentEffect)
//   PATCH /admin/profiles/:id/approve -> status 'approved', now public
//
// Website remediation punch-list (2026-09-03).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const MAGAZINE = path.join(__dirname, '..', '..', 'unplug-magazine.html');
const PROFILES_ROUTE = path.join(__dirname, '..', 'src', 'routes', 'profiles.js');
const PAYMENTS_ROUTE = path.join(__dirname, '..', 'src', 'routes', 'payments.js');
const ADMIN_ROUTE = path.join(__dirname, '..', 'src', 'routes', 'admin.js');

function read(file) {
  assert.ok(fs.existsSync(file), `${path.basename(file)} should exist`);
  return fs.readFileSync(file, 'utf8').split('\r\n').join('\n');
}

test('THE DIRECTORY PAGE EXPLAINS WHAT HAPPENS AFTER "CHOOSE"', () => {
  const src = read(MAGAZINE);
  assert.match(src, /How it works/);
  assert.match(src, /Choose a package/i);
  assert.match(src, /Pay by EFT/i);
  assert.match(src, /We review it/i);
  assert.match(src, /You're live/i);
});

test('THE COPY MATCHES THE REAL STATUS LIFECYCLE, NOT A GUESS', () => {
  // A new profile really does start awaiting payment.
  const profilesSrc = read(PROFILES_ROUTE);
  assert.match(profilesSrc, /'awaiting_payment'/, 'a new profile should still start awaiting_payment');

  // A confirmed payment really does move it to pending, not straight to approved.
  const paymentsSrc = read(PAYMENTS_ROUTE);
  const idx = paymentsSrc.indexOf(`payment.linked_type === 'profile_package'`);
  assert.ok(idx > -1, 'the profile_package payment effect should still exist');
  const effect = paymentsSrc.slice(idx, idx + 300);
  assert.match(effect, /status = 'pending'/, "a confirmed payment should move the profile to 'pending' (awaiting admin review), not straight to 'approved' — if this ever changes, the Directory page's \"We review it\" step becomes wrong and needs updating alongside it");

  // Approval really is a separate, later admin action, not automatic.
  const adminSrc = read(ADMIN_ROUTE);
  assert.match(adminSrc, /profiles\/:id\/approve/,
    'a distinct admin approval route should still exist — if approval is ever automated, the "We review it" step becomes wrong and needs updating alongside it');
});

test("THE PAGE DOESN'T CLAIM A PREVIEW STEP THAT DOESN'T EXIST", () => {
  // The original spec's workflow diagram (docs/spec-extracted.md §2.4) has a
  // Preview screen between completing the profile and paying. Checkout has
  // no such screen — this copy must describe what's actually built, not
  // reproduce a step from the spec that was never implemented.
  const src = read(MAGAZINE);
  const start = src.indexOf('How it works');
  const block = src.slice(start, start + 600);
  assert.ok(!/preview/i.test(block), 'should not claim a Preview step the checkout flow does not have');
});
