#!/usr/bin/env node
// Staging-only smoke-test hotfixes for the member cart.
//
// This script runs before build.js on the staging-control-centre branch and
// patches the build workspace only. It does not rewrite the checked-in member
// dashboard source, and production/main is untouched.
//
// Phase 12 smoke test #35 exposed three regressions:
//   1. renderCart() referenced escapeHtmlM from another script block, which is
//      not guaranteed to exist in the extracted/minified Pages build.
//   2. clicking Add to Cart twice on an unchanged submission created a second
//      backend record before the cart had any chance to recognise the repeat.
//   3. the cart could render before the saved member token was restored, so its
//      first /orders/quote request returned 401 and left the subtotal as a dash.
//
// The fixes below are deliberately narrow and fail loudly if their anchors
// disappear, so a later refactor cannot silently leave staging unprotected.

const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'unplug-member-dashboard.html');
let html = fs.readFileSync(file, 'utf8');

function mustReplace(anchor, replacement, label) {
  if (!html.includes(anchor)) {
    throw new Error(`staging cart hotfix anchor missing: ${label}`);
  }
  html = html.replace(anchor, replacement);
}

// Start authenticated member requests with the saved token immediately.
// The normal session validation still runs afterwards; an invalid token will
// still receive 401 and be cleared by handleMemberSessionExpired(). This only
// removes the page-load race where renderCart()/member panels run first.
mustReplace(
  'let AUTH_TOKEN = null;',
  "let AUTH_TOKEN = localStorage.getItem('unplug_auth_token') || null;",
  'saved member token bootstrap'
);

// Keep the cart's HTML escaping inside the same script block as renderCart(),
// so the production-style script extraction cannot leave the helper behind.
const renderAnchor = 'async function renderCart() {';
const renderPatch = `function escapeCartLabel(str) {
  const d = document.createElement('div');
  d.textContent = str == null ? '' : String(str);
  return d.innerHTML;
}

async function renderCart() {`;
mustReplace(renderAnchor, renderPatch, 'renderCart local escaper');

const labelRefs = (html.match(/escapeHtmlM\(item\.label\)/g) || []).length;
if (labelRefs < 2) {
  throw new Error(`staging cart hotfix expected at least 2 cart label escapes, found ${labelRefs}`);
}
html = html.replace(/escapeHtmlM\(item\.label\)/g, 'escapeCartLabel(item.label)');

// Fingerprint only the currently selected service's actual submission fields.
// Payment method / voucher / terms controls are intentionally excluded: they
// do not make a second content record a different submission.
const listenerAnchor = "document.getElementById('submitAddToCartBtn').addEventListener('click', async () => {";
const listenerPatch = `function cartSubmissionFingerprint(type) {
  const root = document.getElementById('fields-' + type);
  if (!root) return type;
  const parts = [type];
  root.querySelectorAll('input, select, textarea').forEach((el) => {
    const key = el.id || el.name || el.type || el.tagName;
    let value = '';
    if (el.type === 'file') {
      value = Array.from(el.files || []).map((f) =>
        [f.name, f.size, f.lastModified].join(':')).join(',');
    } else if (el.type === 'checkbox' || el.type === 'radio') {
      value = el.checked ? '1' : '0';
    } else {
      value = String(el.value || '').trim();
    }
    parts.push(key + '=' + value);
  });
  return parts.join('|');
}

${listenerAnchor}`;
mustReplace(listenerAnchor, listenerPatch, 'Add to Cart listener');

const startAnchor = `  const type = document.getElementById('submitType').value;
  const btn = document.getElementById('submitAddToCartBtn');
  btn.disabled = true; btn.textContent = 'Adding…';
  try {`;
const startPatch = `  const type = document.getElementById('submitType').value;
  const btn = document.getElementById('submitAddToCartBtn');
  const formFingerprint = cartSubmissionFingerprint(type);
  if (CART.some((item) => item.formFingerprint === formFingerprint)) {
    showSubmitError('This exact submission is already in your cart.');
    return;
  }
  btn.disabled = true; btn.textContent = 'Adding…';
  try {`;
mustReplace(startAnchor, startPatch, 'pre-create duplicate guard');

mustReplace(
  '    CART.push({ linkedType, linkedId, label });',
  '    CART.push({ linkedType, linkedId, label, formFingerprint });',
  'cart fingerprint persistence'
);

fs.writeFileSync(file, html);
console.log('Applied staging member-cart smoke hotfixes.');
