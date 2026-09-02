-- Spine, Phase B3 — events join the submission lifecycle.
--
-- Adds all four Phase-B statuses: changes_requested, resubmitted,
-- credit_issued and expired. Nothing sets them yet; the pathways that do are
-- task 05. A value nobody can write is inert, which is what makes this safe to
-- ship on its own.
--
-- WHY expired BELONGS HERE
--
-- An event finishes. The public feed already relies on that:
--
--   status = 'approved' AND event_date >= CURRENT_DATE
--
-- so a past event stops appearing while its status still reads 'approved',
-- exactly as marketplace listings do. Nothing records that it is over, which
-- means no report can tell an approved event that is coming up from one that
-- happened last year. `expired` names that state.
--
-- Nothing transitions to it in this migration. Which of the date or the status
-- is authoritative once both exist is a decision, not an implementation
-- detail, and today the date is the only truth.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT FIX
--
-- events has event_date, start_time and end_time, but NO end date. A festival
-- running Friday to Sunday has one event_date, so `event_date >= CURRENT_DATE`
-- removes it from the site on Saturday morning while it is still running.
--
-- That is a real bug and it already has a decision behind it — events are to
-- get an end-date field and expire after it rather than at the start. It needs
-- a new column and a change to the feed's condition, which is a different
-- piece of work from adding permitted status values, and doing both at once
-- would put a data change and a behaviour change in the same migration.
--
-- WHY THIS IS SAFE TO RE-RUN
--
-- Migrations execute on every deploy, and changing a CHECK re-validates the
-- whole table each time. Every value an existing row could hold is kept: the
-- four originals are untouched and only new ones added. Nothing is renamed.

ALTER TABLE events DROP CONSTRAINT IF EXISTS events_status_check;
ALTER TABLE events ADD CONSTRAINT events_status_check
  CHECK (status IN (
    'awaiting_payment', 'pending', 'approved', 'rejected',
    'changes_requested', 'resubmitted', 'credit_issued', 'expired'
  ));
