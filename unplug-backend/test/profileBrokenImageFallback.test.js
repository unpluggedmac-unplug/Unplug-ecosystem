'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

test('directory biographies suppress duplicated and failed legacy images', () => {
  const helper = fs.readFileSync(path.join(ROOT, 'unplug-responsive-images.js'), 'utf8');
  const page = fs.readFileSync(path.join(ROOT, 'unplug-magazine.html'), 'utf8');

  assert.match(helper, /document\.addEventListener\('error'/);
  assert.match(helper, /image\.tagName === 'IMG'/);
  assert.match(helper, /image\.closest\('\.rich-bio'\)/);
  assert.match(helper, /image\.remove\(\)/);
  assert.match(page, /src="unplug-responsive-images\.js"/);
});
