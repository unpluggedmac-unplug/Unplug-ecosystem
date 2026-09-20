'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  MEMBER_STATUS_BY_INTERNAL,
  memberStatusFor,
  withMemberStatus,
} = require('../src/utils/growthMemberStatus');

const ROOT = path.join(__dirname, '..', '..');
const BACKEND = path.join(ROOT, 'unplug-backend');

const EXPECTED = {
  draft: { status: 'draft', label: 'Draft' },
  new: { status: 'submitted', label: 'Submitted' },
  submitted: { status: 'submitted', label: 'Submitted' },
  under_review: { status: 'under_review', label: 'Under review' },
  assessment_in_progress: { status: 'under_review', label: 'Under review' },
  information_requested: { status: 'action_needed', label: 'Action needed' },
  contacted: { status: 'contacted', label: 'We’ve contacted you' },
  plan_in_progress: { status: 'growth_support', label: 'Growth support in progress' },
  in_progress: { status: 'growth_support', label: 'Growth support in progress' },
  completed: { status: 'completed', label: 'Completed' },
  withdrawn: { status: 'withdrawn', label: 'Withdrawn' },
  closed: { status: 'closed', label: 'Closed' },
};

test('every Growth internal state has the approved member-facing status and label', () => {
  assert.deepEqual(MEMBER_STATUS_BY_INTERNAL, EXPECTED);

  const adminSource = fs.readFileSync(path.join(BACKEND, 'src/routes/growthAdmin.js'), 'utf8');
  const setMatch = adminSource.match(/const STATUSES = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(setMatch, 'Growth Admin status vocabulary should remain discoverable');
  const adminStatuses = [...setMatch[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);

  for (const status of ['draft', ...adminStatuses]) {
    assert.ok(MEMBER_STATUS_BY_INTERNAL[status], `Missing member-facing mapping for internal status: ${status}`);
  }
});

test('member-facing status is additive and never replaces the internal workflow status', () => {
  const decorated = withMemberStatus({ id: 42, status: 'assessment_in_progress' });
  assert.equal(decorated.status, 'assessment_in_progress');
  assert.equal(decorated.member_status, 'under_review');
  assert.equal(decorated.member_status_label, 'Under review');
});

test('an unknown future internal state fails closed instead of leaking internal vocabulary to members', () => {
  assert.deepEqual(memberStatusFor('future_internal_state'), {
    member_status: 'under_review',
    member_status_label: 'Under review',
  });
});

test('Growth V2 member responses consistently add the member-facing status contract', () => {
  const route = fs.readFileSync(path.join(BACKEND, 'src/routes/growthApplicationV2.js'), 'utf8');
  assert.match(route, /require\('\.\.\/utils\/growthMemberStatus'\)/);
  assert.match(route, /applications: result\.rows\.map\(withMemberStatus\)/);
  assert.match(route, /application: withMemberStatus\(existingDraft\.rows\[0\]\)/);
  assert.match(route, /application: withMemberStatus\(application\), form: active/);
  assert.match(route, /application: withMemberStatus\(application\), informationRequests/);
  assert.match(route, /application: withMemberStatus\(\{ id: applicationId, status: 'submitted'/);
  assert.match(route, /application: withMemberStatus\(\{ id: applicationId, status: 'withdrawn'/);
});

test('Admin keeps the detailed internal status and is not switched to the member-facing vocabulary', () => {
  const admin = fs.readFileSync(path.join(BACKEND, 'src/routes/growthAdmin.js'), 'utf8');
  assert.doesNotMatch(admin, /growthMemberStatus|member_status|member_status_label/);
  assert.match(admin, /UPDATE growth_applications SET status=\$2/);
  assert.match(admin, /return res\.json\(\{application:\{id:applicationId,status:to\}\}\)/);
});

test('member workspace renders the backend member label while lifecycle actions still use internal status', () => {
  const member = fs.readFileSync(path.join(ROOT, 'unplug-growth-application-v2.html'), 'utf8');
  assert.match(member, /application\?\.member_status_label/);
  assert.match(member, /application\?\.member_status\|\|application\?\.status/);
  assert.match(member, /visible=memberStatus\(application\)/);
  assert.match(member, /\['draft','withdrawn'\]\.includes\(app\.status\)/);
  assert.match(member, /\['withdrawn','completed','closed'\]\.includes\(application\.status\)/);
  assert.match(member, /state\.data\?\.application\?\.status==='draft'/);
});
