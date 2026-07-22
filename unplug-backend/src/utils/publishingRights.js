// Who can publish without paying, in one place.
//
// Defined once because the rule is applied at several submission points
// (articles, events, gallery) and a copy that drifts is how someone ends up
// billed for something they were told was free.
//
// Admins are editorial staff. Consultants are staff on the company domain who
// list work on clients' behalf; charging them for that would just be the
// company invoicing itself.
const FREE_PUBLISHING_ROLES = ['admin', 'consultant'];

function publishesFree(user) {
  return !!user && FREE_PUBLISHING_ROLES.includes(user.role);
}

// Editorial staff publish straight to the site. Consultants still go through
// approval — they act for clients, so a second pair of eyes stays useful —
// but never through payment.
function statusForNewSubmission(user, hasCredit) {
  if (!user) return 'awaiting_payment';
  if (user.role === 'admin') return 'approved';
  if (user.role === 'consultant') return 'pending';
  return hasCredit ? 'pending' : 'awaiting_payment';
}

module.exports = { publishesFree, statusForNewSubmission, FREE_PUBLISHING_ROLES };
