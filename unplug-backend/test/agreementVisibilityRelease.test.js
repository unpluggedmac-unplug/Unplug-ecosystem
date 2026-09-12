'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

test('Agreement forms have independent public and member-dashboard publishing controls', () => {
  const migration = read('unplug-backend', 'db', 'migrations', '199_agreement_member_visibility.sql');
  assert.match(migration, /ADD COLUMN IF NOT EXISTS member_visible BOOLEAN NOT NULL DEFAULT false/i);
  const route = read('unplug-backend', 'src', 'routes', 'agreementForms.js');
  assert.match(route, /router\.get\('\/member', requireAuth/);
  assert.match(route, /member_visible = true/);
  assert.match(route, /memberVisible/);
  const admin = read('unplug-agreements-admin.html');
  assert.match(admin, /memberVisible/);
  assert.match(admin, /Show on member dashboard/);
  const dashboard = read('unplug-member-dashboard.html');
  assert.match(dashboard, /availableagreements/);
  assert.match(dashboard, /agreement-forms\/member/);
  assert.match(dashboard, /member_visible=true/);
  assert.match(dashboard, /Publicly listed agreements are controlled separately/);
});
