// DEAF-003 and PASSPORT-001, checked against the real create-passport
// modal in unplug-magazine.html.
//
// DEAF-003: the Passport panel already said "shows for 14 days" but never
// said WHY, or what happens once it expires — and the punch-list's ask is
// specifically to explain this BEFORE submission, not only discoverable
// afterwards via the self-service manage link already built. Added an
// explainer naming the reason (freshness), the renewal path (the same
// emailed manage link, already built), and reiterating contact-detail
// privacy, right in the create-passport modal.
//
// PASSPORT-001: no preview of the finished card existed before submitting.
// Added one that reuses dcPassportCardBodyHtml() — the exact function the
// real live card renders with — so what a member sees while typing is
// genuinely what an employer will see, not a hand-maintained mockup that
// could quietly drift from the real card.
//
// Website remediation punch-list (2026-09-03).
//
// Run with:  npm test   (from unplug-backend/)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', '..', 'unplug-magazine.html');

function read() {
  assert.ok(fs.existsSync(FILE), 'unplug-magazine.html should exist');
  return fs.readFileSync(FILE, 'utf8').split('\r\n').join('\n');
}

test('THE CREATE-PASSPORT MODAL EXPLAINS WHY 14 DAYS, RENEWAL, AND CONTACT PRIVACY — BEFORE THE SUBMIT BUTTON', () => {
  const src = read();
  const modalStart = src.indexOf('id="dcPassportModal"');
  const submitIdx = src.indexOf('id="dcPassSubmit"', modalStart);
  assert.ok(modalStart > -1 && submitIdx > modalStart);
  const explainer = src.slice(modalStart, submitIdx);
  assert.match(explainer, /14\s*days/);
  assert.match(explainer, /renew/i, 'must say renewal is possible, not just that it expires');
  assert.match(explainer, /never shown publicly|never shown|contact details/i);
});

test('dcPassportCardBodyHtml IS THE ONE PLACE THE CARD LAYOUT IS BUILT — dcPassportHtml REUSES IT RATHER THAN DUPLICATING IT', () => {
  const src = read();
  const bodyFnIdx = src.indexOf('function dcPassportCardBodyHtml(');
  assert.ok(bodyFnIdx > -1);
  const cardFnIdx = src.indexOf('function dcPassportHtml(');
  assert.ok(cardFnIdx > bodyFnIdx, 'dcPassportHtml should be defined after, and reuse, the shared body function');
  const cardFnBody = src.slice(cardFnIdx, cardFnIdx + 400);
  assert.match(cardFnBody, /dcPassportCardBodyHtml\(p\)/);
});

test('THE LIVE PREVIEW ELEMENT EXISTS IN THE MODAL, BEFORE THE SUBMIT BUTTON', () => {
  const src = read();
  const modalStart = src.indexOf('id="dcPassportModal"');
  const previewIdx = src.indexOf('id="dcPassPreview"', modalStart);
  const submitIdx = src.indexOf('id="dcPassSubmit"', modalStart);
  assert.ok(previewIdx > modalStart && previewIdx < submitIdx, 'the preview must appear before the submit button, not after');
});

test('EVERY PREVIEW-RELEVANT FIELD (NAME, IMAGE, SKILLS, CERTS, COMMS, AVAILABILITY) TRIGGERS A LIVE UPDATE', () => {
  const src = read();
  const idx = src.indexOf("['dcPassName', 'dcPassImage', 'dcPassSkills', 'dcPassCerts', 'dcPassComm', 'dcPassAvail'].forEach");
  assert.ok(idx > -1, 'all six preview-relevant fields should be wired to updateDcPassPreview in one place');
  const block = src.slice(idx, idx + 200);
  assert.match(block, /addEventListener\('input', updateDcPassPreview\)/);
});

test('updateDcPassPreview BUILDS FROM THE SHARED CARD-BODY FUNCTION, NOT A SEPARATE HAND-WRITTEN TEMPLATE', () => {
  const src = read();
  const idx = src.indexOf('function updateDcPassPreview()');
  assert.ok(idx > -1);
  const body = src.slice(idx, idx + 500);
  assert.match(body, /dcPassportCardBodyHtml\(\{/);
});

test('OPENING THE MODAL RENDERS THE PREVIEW IMMEDIATELY, NOT ONLY AFTER THE FIRST KEYSTROKE', () => {
  const src = read();
  const fnIdx = src.indexOf('function setupDcPassportModal()');
  assert.ok(fnIdx > -1);
  const idx = src.indexOf("openBtn.addEventListener('click'", fnIdx);
  assert.ok(idx > -1);
  const line = src.slice(idx, idx + 200);
  assert.match(line, /updateDcPassPreview\(\)/);
});
