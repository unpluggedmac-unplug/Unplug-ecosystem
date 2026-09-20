'use strict';

const MEMBER_STATUS_BY_INTERNAL = Object.freeze({
  draft: Object.freeze({ status: 'draft', label: 'Draft' }),
  new: Object.freeze({ status: 'submitted', label: 'Submitted' }),
  submitted: Object.freeze({ status: 'submitted', label: 'Submitted' }),
  under_review: Object.freeze({ status: 'under_review', label: 'Under review' }),
  assessment_in_progress: Object.freeze({ status: 'under_review', label: 'Under review' }),
  information_requested: Object.freeze({ status: 'action_needed', label: 'Action needed' }),
  contacted: Object.freeze({ status: 'contacted', label: 'We’ve contacted you' }),
  plan_in_progress: Object.freeze({ status: 'growth_support', label: 'Growth support in progress' }),
  in_progress: Object.freeze({ status: 'growth_support', label: 'Growth support in progress' }),
  completed: Object.freeze({ status: 'completed', label: 'Completed' }),
  withdrawn: Object.freeze({ status: 'withdrawn', label: 'Withdrawn' }),
  closed: Object.freeze({ status: 'closed', label: 'Closed' }),
});

function memberStatusFor(internalStatus) {
  const status = String(internalStatus || '').trim();
  const mapped = MEMBER_STATUS_BY_INTERNAL[status];
  if (mapped) {
    return {
      member_status: mapped.status,
      member_status_label: mapped.label,
    };
  }

  // Fail closed on a newly introduced internal workflow state: members should
  // never see an unexplained internal label just because the admin vocabulary
  // grew before this mapping was updated. The contract test below still fails
  // when an expected internal status is missing from the map.
  return {
    member_status: 'under_review',
    member_status_label: 'Under review',
  };
}

function withMemberStatus(application) {
  if (!application || typeof application !== 'object') return application;
  return { ...application, ...memberStatusFor(application.status) };
}

module.exports = {
  MEMBER_STATUS_BY_INTERNAL,
  memberStatusFor,
  withMemberStatus,
};
