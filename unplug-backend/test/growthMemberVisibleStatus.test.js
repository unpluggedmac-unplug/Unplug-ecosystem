'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { growthMemberStatus } = require('../src/utils/growthMemberStatus');

const ROOT = path.join(__dirname, '..', '..');

test('every internal Growth workflow state maps to the approved member vocabulary', () => {
  const expected = {
    new: 'Submitted',
    submitted: 'Submitted',
    under_review: 'Under review',
    assessment_in_progress: 'Under review',
    information_requested: 'Action required',
    contacted: 'Contacted',
    plan_in_progress: 'Growth plan in progress',
    in_progress: 'Growth plan in progress',
    completed: 'Completed',
    withdrawn: 'Withdrawn',
    closed: 'Closed',
  };
  for (const [internal, label] of Object.entries(expected)) {
    assert.equal(growthMemberStatus(internal).label, label, internal);
  }
});

test('only information requests are action-required and final states are terminal', () => {
  assert.equal(growthMemberStatus('information_requested').actionRequired, true);
  assert.equal(growthMemberStatus('under_review').actionRequired, false);
  for (const status of ['completed', 'withdrawn', 'closed']) {
    assert.equal(growthMemberStatus(status).terminal, true, status);
  }
  assert.equal(growthMemberStatus('in_progress').terminal, false);
});

test('unknown internal states fail private as Under review', () => {
  const visible = growthMemberStatus('private_admin_experiment', '2026-09-20T08:00:00Z');
  assert.deepEqual(visible, {
    key: 'under_review',
    label: 'Under review',
    description: 'The Unplug team is reviewing your application.',
    actionRequired: false,
    terminal: false,
    updatedAt: '2026-09-20T08:00:00Z',
  });
  assert.doesNotMatch(JSON.stringify(visible), /private_admin_experiment/);
});

test('member API derives status from owned applications without exposing private review material', () => {
  const route = fs.readFileSync(path.join(ROOT, 'unplug-backend/src/routes/growthApplicationV2.js'), 'utf8');
  assert.match(route, /growthMemberStatus/);
  assert.match(route, /memberVisibleStatus/);
  assert.match(route, /WHERE id=\$1 AND user_id=\$2/);
  assert.match(route, /WHERE user_id=\$1/);
  assert.doesNotMatch(route, /growth_assessments|growth_plans|internal_notes/);
});

test('member page renders backend labels and explanations instead of raw admin terms', () => {
  const page = fs.readFileSync(path.join(ROOT, 'unplug-growth-application-v2.html'), 'utf8');
  assert.match(page, /memberVisibleStatus/);
  assert.match(page, /visible\.label/);
  assert.match(page, /visible\.description/);
  assert.match(page, /Status updated/);
  assert.match(page, /Object\.assign\(listItem,state\.data\.application\)/);
  assert.match(page, /Internal assessments, scores, private notes and recommendations stay/);
  assert.doesNotMatch(page, /Information requested<\/span>/);
  assert.doesNotMatch(page, /Assessment in progress<\/span>/);
});
