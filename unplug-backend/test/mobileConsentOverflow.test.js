'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const page = fs.readFileSync(path.join(ROOT, 'unplug-magazine.html'), 'utf8');

test('mobile POPIA consent is explicitly constrained to the viewport', () => {
  assert.match(page, /@media\(max-width:640px\)\{[\s\S]*?\.consent-bar\{ padding:12px; overflow-x:hidden; \}/);
  assert.match(page, /\.consent-card\{[\s\S]*?max-width:100%;[\s\S]*?min-width:0;[\s\S]*?overflow-x:hidden;/);
  assert.match(page, /\.consent-card h2,[\s\S]*?overflow-wrap:anywhere;[\s\S]*?word-break:break-word;/);
});

test('mobile POPIA consent actions cannot force horizontal overflow', () => {
  assert.match(page, /\.consent-actions\{ flex-direction:column; width:100%; min-width:0; \}/);
  assert.match(page, /\.consent-actions \.btn\{[\s\S]*?width:100%;[\s\S]*?min-width:0;[\s\S]*?max-width:100%;[\s\S]*?white-space:normal;/);
});
