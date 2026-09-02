-- Spine, Phase B2 — marketplace listings join the submission lifecycle.
--
-- Adds all four Phase-B statuses: changes_requested, resubmitted,
-- credit_issued and expired. Nothing sets them yet; the pathways that do are
-- task 05. A value nobody can write is inert, which is what makes this safe to
-- ship on its own.
--
-- WHY FOUR HERE, WHERE THE GALLERY GOT THREE
--
-- A marketplace listing runs for a term. duration_days is 7, 14, 21 or 28, and
-- active_from / active_to bound the window the public feed already checks:
--
--   l.status = 'approved'
--   AND (l.active_from IS NULL OR l.active_from <= CURRENT_DATE)
--   AND (l.active_to   IS NULL OR l.active_to   >= CURRENT_DATE)
--
-- So expiry is real here, it is just IMPLICIT — a listing past active_to
-- silently stops appearing while its status still reads 'approved'. Nothing
-- records that it finished, which means no report can tell an approved listing
-- that is running from one that ran months ago. `expired` gives that state a
-- name. The gallery got three because a gallery submission is a one-off
-- purchase of photos that stay published, with no term to run out.
--
-- Nothing switches to `expired` in this migration. Making the transition happen
-- is renewal work, and it needs a decision about whether the date or the status
-- is the authority once both exist.
--
-- WHY THIS IS SAFE TO RE-RUN
--
-- These migrations execute on EVERY deploy, and changing a CHECK means dropping
-- and re-adding it, which re-validates the whole table each time. Every value
-- an existing row could hold is kept — the four originals are untouched and
-- only new ones are added. Nothing is renamed.

ALTER TABLE marketplace_listings DROP CONSTRAINT IF EXISTS marketplace_listings_status_check;
ALTER TABLE marketplace_listings ADD CONSTRAINT marketplace_listings_status_check
  CHECK (status IN (
    'awaiting_payment', 'pending', 'approved', 'rejected',
    'changes_requested', 'resubmitted', 'credit_issued', 'expired'
  ));
