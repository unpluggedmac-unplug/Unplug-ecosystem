// Who can publish without paying, in one place.
//
// Defined once because the rule is applied at several submission points
// (articles, events, gallery) and a copy that drifts is how someone ends up
// billed for something they were told was free.
//
// Admins are editorial staff. Consultants are staff on the company domain who
// list work on clients' behalf; charging them for that would just be the
// company invoicing itself. Unlike the role itself, free publishing for a
// consultant is also individually revocable — see users.free_publishing_enabled
// (176_consultant_free_publishing_toggle.sql) — so an admin can pause it for
// one person without demoting them out of the role. `user` here comes from
// the signed-in JWT, which only carries what login put there, so — same as
// a role change — a toggle takes effect at that person's next sign-in, not
// mid-session.
const FREE_PUBLISHING_ROLES = ['admin', 'consultant'];

function consultantFreePublishingAllowed(user) {
  // Defaults to allowed: an older token minted before this column existed
  // carries no such claim, and that must not silently revoke everyone.
  return user.free_publishing_enabled !== false;
}

function publishesFree(user) {
  if (!user || !FREE_PUBLISHING_ROLES.includes(user.role)) return false;
  if (user.role === 'consultant') return consultantFreePublishingAllowed(user);
  return true;
}

// Editorial staff publish straight to the site. Consultants still go through
// approval — they act for clients, so a second pair of eyes stays useful —
// but never through payment, unless their free publishing has been switched
// off, in which case they are just a normal paying member for this submission.
function statusForNewSubmission(user, hasCredit) {
  if (!user) return 'awaiting_payment';
  if (user.role === 'admin') return 'approved';
  if (user.role === 'consultant' && consultantFreePublishingAllowed(user)) return 'pending';
  return hasCredit ? 'pending' : 'awaiting_payment';
}

module.exports = { publishesFree, statusForNewSubmission, FREE_PUBLISHING_ROLES };
