-- Spine, Phase B4 — highlights join the submission lifecycle.
--
-- Adds all four Phase-B statuses: changes_requested, resubmitted,
-- credit_issued and expired. Nothing sets them yet; the pathways that do are
-- task 05.
--
-- WHY expired BELONGS HERE
--
-- A highlight runs for a term. duration_days is 7, 14, 21 or 28, and the row
-- carries start_date and end_date. The member-facing list already computes
-- "Completed" from end_date < today, so a finished highlight is recognised —
-- but only by arithmetic. Its status still reads 'approved' forever, so no
-- report can separate a highlight that is running from one that ended in
-- March. `expired` names that state.
--
-- Nothing transitions to it here. Whether the date or the status is
-- authoritative once both exist is a decision, and today the dates are the
-- only truth.
--
-- WHY THE ROUTE CHANGED IN THE SAME COMMIT
--
-- GET /highlights/mine turns a status into a label for the member, and the
-- chain ended `else label = 'Active'`. A highlight in any of the four new
-- statuses would have fallen through to that and told the member it was
-- running. Nothing can set those statuses yet, so nothing is broken today —
-- but adding the values without the labels would leave a migration that makes
-- a wrong answer reachable, waiting for task 05 to trip over. The labels are
-- added alongside.
--
-- WHY THIS IS SAFE TO RE-RUN
--
-- Migrations execute on every deploy, and changing a CHECK re-validates the
-- whole table each time. Every value an existing row could hold is kept: the
-- four originals are untouched and only new ones added. Nothing is renamed.

ALTER TABLE highlights DROP CONSTRAINT IF EXISTS highlights_status_check;
ALTER TABLE highlights ADD CONSTRAINT highlights_status_check
  CHECK (status IN (
    'awaiting_payment', 'pending', 'approved', 'rejected',
    'changes_requested', 'resubmitted', 'credit_issued', 'expired'
  ));
