'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'unplug-magazine.html'), 'utf8');

function consentCss() {
  const start = html.indexOf('/* ---- POPIA consent bar ---- */');
  const end = html.indexOf('/* ---- admin-added page blocks ---- */', start);
  assert.ok(start >= 0 && end > start, 'POPIA consent CSS block must exist');
  return html.slice(start, end);
}

test('mobile consent overlay contains horizontal overflow at the viewport boundary', () => {
  const css = consentCss();
  assert.match(css, /\.consent-bar\{[^}]*overflow-x:hidden;/s);
  assert.match(css, /\.consent-card\{[^}]*max-width:min\(520px,100%\);[^}]*min-width:0;/s);
  assert.match(css, /\.consent-card\{[^}]*overflow-y:auto; overflow-x:hidden;/s);
});

test('consent actions can shrink and wrap instead of forcing the viewport wider', () => {
  const css = consentCss();
  assert.match(css, /\.consent-actions\{[^}]*min-width:0;/s);
  assert.match(css, /\.consent-actions \.btn\{[^}]*flex:1 1 0;[^}]*min-width:0;[^}]*white-space:normal;[^}]*overflow-wrap:anywhere;/s);
});

test('small screens use reduced dialog padding and full-width stacked actions', () => {
  const css = consentCss();
  assert.match(css, /@media\(max-width:640px\)\{[\s\S]*\.consent-bar\{ padding:12px; \}/);
  assert.match(css, /\.consent-card\{ max-width:100%; padding:28px 18px 22px; \}/);
  assert.match(css, /\.consent-actions\{ flex-direction:column; width:100%; \}/);
  assert.match(css, /\.consent-actions \.btn\{ width:100%; max-width:100%; \}/);
});
