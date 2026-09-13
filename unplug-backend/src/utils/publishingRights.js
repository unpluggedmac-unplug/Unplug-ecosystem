// Who can publish without paying, in one place.
//
// Defined once because the rule is applied at several submission points
// (articles, events, gallery) and a copy that drifts is how someone ends up
// billed for something they were told was free.
//
// Admins are editorial staff. Representatives list work on clients' behalf;
// charging them for that would just be the company invoicing itself. Free
// publishing for a Representative is individually revocable — see
// users.free_publishing_enabled (176_consultant_free_publishing_toggle.sql)
// — so an admin can pause it for one person without removing their
// Representative access. `user` here comes from the signed-in JWT, which
// only carries what login put there, so — same as any other grant — a
// toggle takes effect at that person's next sign-in, not mid-session.
//
// Representative access is a flag independent of `role`
// (210_representative_flag.sql), not a role itself — a Staff or Admin
// account can also be a Representative, so this checks user.is_representative
// rather than any particular role value.
function consultantFreePublishingAllowed(user) {
  // Defaults to allowed: an older token minted before this column existed
  // carries no such claim, and that must not silently revoke everyone.
  return user.free_publishing_enabled !== false;
}

function publishesFree(user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.is_representative) return consultantFreePublishingAllowed(user);
  return false;
}

// Editorial staff publish straight to the site. Representatives still go
// through approval — they act for clients, so a second pair of eyes stays
// useful — but never through payment, unless their free publishing has been
// switched off, in which case they are just a normal paying member for this
// submission.
function statusForNewSubmission(user, hasCredit) {
  if (!user) return 'awaiting_payment';
  if (user.role === 'admin') return 'approved';
  if (user.is_representative && consultantFreePublishingAllowed(user)) return 'pending';
  return hasCredit ? 'pending' : 'awaiting_payment';
}

module.exports = { publishesFree, statusForNewSubmission };
