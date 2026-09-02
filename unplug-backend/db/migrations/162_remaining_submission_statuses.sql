-- Spine, Phase B6 — the last three services join the submission lifecycle.
--
-- profiles, competition_entries and top10_entries were the three left after
-- Phase B. This finishes the submission vocabulary: every table in
-- SUBMISSION_TABLES now carries the same review statuses.
--
-- WHAT EACH ONE GAINS
--
--   profiles            change requests AND credit. A Directory profile is a
--                       returnable submission — it has editable fields and its
--                       owner is on the row — so an admin can now ask for a bio
--                       or a feature image to be changed rather than refusing
--                       the whole listing.
--   competition_entries credit on a declined paid entry.
--   top10_entries       credit on a declined paid entry. Nothing else: the row
--                       carries no editorial fields of its own, so there is
--                       nothing to ask a member to change.
--
-- expired ON profiles, NOT ON THE OTHER TWO
--
-- profiles carries renews_at: a paid Directory listing runs for a term and is
-- renewed. So a profile can genuinely finish, and `expired` names that.
--
-- A competition entry does not expire on its own — it ends when the competition
-- closes, which is the competition's state and not the entry's. Giving the
-- entry a status nothing can ever set would be the unreachable-state problem
-- the whole phase has avoided. Six services in, the rule has not been bent:
-- `expired` only where something can actually end that service.
--
-- WHAT THIS MIGRATION DOES NOT DECIDE
--
-- Profiles were held back from Phase B for a reason that still stands: the
-- specification's Profile vocabulary (DRAFT/PRIVATE/PUBLISHED/SUSPENDED/
-- ARCHIVED) describes VISIBILITY, while profiles.status describes APPROVAL, and
-- decision 6 separates those — publishing your own profile needs no approval,
-- buying a Directory Listing against it does.
--
-- Adding review statuses does not touch that question. status keeps meaning
-- approval, exactly as it did; whether a second visibility field is needed is
-- still open and still belongs with the Directory Listing work. Nothing here
-- prejudges it.
--
-- WHY THIS IS SAFE TO RE-RUN
--
-- Migrations execute on every deploy, and changing a CHECK re-validates the
-- whole table each time. Every value an existing row could hold is kept, only
-- new ones are added, and nothing is renamed.

ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_status_check;
ALTER TABLE profiles ADD CONSTRAINT profiles_status_check
  CHECK (status IN (
    'awaiting_payment', 'pending', 'approved', 'rejected',
    'changes_requested', 'resubmitted', 'credit_issued', 'expired'
  ));

ALTER TABLE competition_entries DROP CONSTRAINT IF EXISTS competition_entries_status_check;
ALTER TABLE competition_entries ADD CONSTRAINT competition_entries_status_check
  CHECK (status IN (
    'awaiting_payment', 'pending', 'approved', 'rejected',
    'changes_requested', 'resubmitted', 'credit_issued'
  ));

ALTER TABLE top10_entries DROP CONSTRAINT IF EXISTS top10_entries_status_check;
ALTER TABLE top10_entries ADD CONSTRAINT top10_entries_status_check
  CHECK (status IN (
    'awaiting_payment', 'pending', 'approved', 'rejected',
    'changes_requested', 'resubmitted', 'credit_issued'
  ));
