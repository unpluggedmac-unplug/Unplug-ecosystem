const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'unplug-admin-dashboard.html'), 'utf8');

test('REPRESENTATIVE LINKING USES REAL DROPDOWNS INSTEAD OF NUMBER PROMPTS', () => {
  assert.match(html, /id="clRepresentativeSelect"/);
  assert.match(html, /id="clMemberSelect"/);
  assert.match(html, /id="clLinkBtn"/);
  assert.match(html, /id="clUnlinkBtn"/);

  const start = html.indexOf('// --- Sales consultant <-> account linking');
  const end = html.indexOf('// --- Promote an existing member to Representative', start);
  assert.ok(start >= 0 && end > start, 'consultant-linking UI block should exist');
  const block = html.slice(start, end);
  assert.doesNotMatch(block, /prompt\(/,
    'linking a representative to an account must not fall back to typed-number prompts');
});

test('MEMBER ACCOUNT CARDS HAVE AN ASSIGNED REPRESENTATIVE DROPDOWN', () => {
  assert.match(html, /class="u-consultant"/);
  assert.match(html, /Assigned representative/);
  assert.match(html, /salesConsultantId:\s*row\.querySelector\('\.u-consultant'\)/);
});
