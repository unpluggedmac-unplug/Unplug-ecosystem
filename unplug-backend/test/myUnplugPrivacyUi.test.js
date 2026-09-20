'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const dashboard = fs.readFileSync(path.join(ROOT, 'unplug-member-dashboard.html'), 'utf8');
const magazine = fs.readFileSync(path.join(ROOT, 'unplug-magazine.html'), 'utf8');
const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'myUnplug.js'), 'utf8');

test('My Unplug dashboard exposes all approved optional-field privacy controls', () => {
  for (const key of ['avatar','about','country','province','city','interests','skills','purposes','tags']) {
    assert.match(dashboard, new RegExp(`data-mu-vis=["']${key}["']`), `missing privacy control: ${key}`);
  }
  assert.match(dashboard, /id="muSaveVisibilityBtn"/);
  assert.match(dashboard, /\/my-unplug\/me\/visibility/);
  assert.match(dashboard, /@username[^]*display name[^]*always visible/i);
});

test('custom interests are editable, saved separately and never presented as global taxonomy creation', () => {
  assert.match(dashboard, /id="muCustomInterests"/);
  assert.match(dashboard, /customInterests:\s*muCustomInterestValues\(\)/);
  assert.match(dashboard, /not added to everyone/i);
  assert.match(route, /mu_profile_custom_interests/);
  assert.doesNotMatch(route, /INSERT INTO mu_interests[\s\S]{0,500}customInterests/);
});

test('public My Unplug rendering consumes only the server-filtered optional fields', () => {
  assert.match(magazine, /const publicInterests = \[\.\.\.\(t\.interests/);
  assert.match(magazine, /\.\.\.\(t\.customInterests/);
  assert.match(magazine, /block\('Tags', publicTags\)/);
  assert.match(route, /PUBLIC_TAXONOMY_FLAGS/);
  assert.match(route, /field_visibility->>'about'/);
  assert.match(route, /field_visibility->>'avatar'/);
  assert.match(route, /field_visibility->>'tags'/);
});
