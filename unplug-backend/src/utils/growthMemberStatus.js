'use strict';

// Growth has a deliberately detailed internal workflow. Members need a
// smaller, stable vocabulary that explains where their application is without
// exposing internal assessment mechanics. Keep this mapping server-side so
// every member surface receives the same meaning.
const MEMBER_STATUSES = Object.freeze({
  draft: Object.freeze({
    key: 'draft',
    label: 'Draft',
    description: 'Your application is saved and has not been submitted yet.',
  }),
  submitted: Object.freeze({
    key: 'submitted',
    label: 'Submitted',
    description: 'Unplug has received your application and it is waiting for review.',
  }),
  under_review: Object.freeze({
    key: 'under_review',
    label: 'Under review',
    description: 'The Unplug team is reviewing your application.',
  }),
  action_required: Object.freeze({
    key: 'action_required',
    label: 'Action required',
    description: 'Unplug needs more information from you. Open the request below to respond.',
    actionRequired: true,
  }),
  contacted: Object.freeze({
    key: 'contacted',
    label: 'Contacted',
    description: 'The Unplug team has contacted you about your application.',
  }),
  growth_plan_in_progress: Object.freeze({
    key: 'growth_plan_in_progress',
    label: 'Growth plan in progress',
    description: 'Unplug is working with you on the next steps in your Growth Journey.',
  }),
  completed: Object.freeze({
    key: 'completed',
    label: 'Completed',
    description: 'This Growth Journey has been completed and remains available in your history.',
    terminal: true,
  }),
  withdrawn: Object.freeze({
    key: 'withdrawn',
    label: 'Withdrawn',
    description: 'You withdrew this application. It remains available in your history.',
    terminal: true,
  }),
  closed: Object.freeze({
    key: 'closed',
    label: 'Closed',
    description: 'Unplug has closed this application. It remains available in your history.',
    terminal: true,
  }),
});

const INTERNAL_TO_MEMBER = Object.freeze({
  draft: 'draft',
  new: 'submitted',
  submitted: 'submitted',
  under_review: 'under_review',
  assessment_in_progress: 'under_review',
  information_requested: 'action_required',
  contacted: 'contacted',
  plan_in_progress: 'growth_plan_in_progress',
  in_progress: 'growth_plan_in_progress',
  completed: 'completed',
  withdrawn: 'withdrawn',
  closed: 'closed',
});

function growthMemberStatus(internalStatus, updatedAt = null) {
  // An unfamiliar future internal status must fail private: show the neutral
  // review state instead of leaking a new admin-only workflow term.
  const key = INTERNAL_TO_MEMBER[internalStatus] || 'under_review';
  const definition = MEMBER_STATUSES[key];
  return {
    key: definition.key,
    label: definition.label,
    description: definition.description,
    actionRequired: definition.actionRequired === true,
    terminal: definition.terminal === true,
    updatedAt: updatedAt || null,
  };
}

module.exports = { growthMemberStatus, INTERNAL_TO_MEMBER, MEMBER_STATUSES };
