const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', '..');
const builder = fs.readFileSync(path.join(root, 'build.js'), 'utf8');
const magazine = fs.readFileSync(path.join(root, 'unplug-magazine.html'), 'utf8');

test('production builder fails closed on JavaScript and CSS warnings', () => {
  assert.match(builder, /produced a JavaScript build warning/);
  assert.match(builder, /produced a CSS build warning/);
  assert.doesNotMatch(builder, /console\.warn\(`  ! \$\{name\}/);
});

test('page title map contains one nominate route', () => {
  const map = magazine.match(/const PAGE_TITLES = \{([\s\S]*?)\n  \};/);
  assert.ok(map, 'PAGE_TITLES map must exist');
  assert.equal((map[1].match(/\bnominate\s*:/g) || []).length, 1);
});
