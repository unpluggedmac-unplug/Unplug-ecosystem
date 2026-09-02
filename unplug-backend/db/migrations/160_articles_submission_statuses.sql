-- Spine, Phase B5 — articles join the submission lifecycle.
--
-- Adds changes_requested, resubmitted and credit_issued. Nothing sets them
-- yet; the pathways that do are task 05.
--
-- The biggest service on the board by a wide margin — roughly 1,340 references
-- across routes, tests and the frontend — which is why it was left until the
-- pattern had been proven on four quieter ones.
--
-- WHY THREE, NOT FOUR
--
-- An article does not expire. There is no duration, no end date, and no
-- mechanism anywhere that stops showing one. `scheduled_for` looks like a date
-- of that kind but works the other way: it holds an article back UNTIL a date,
-- and the public feed reads
--
--   a.status = 'approved' AND (a.scheduled_for IS NULL OR a.scheduled_for <= CURRENT_DATE)
--
-- so an article appears from that date onward and then stays. Adding `expired`
-- would be a state nothing could reach — the same reason the gallery went
-- without it.
--
-- Five services in, the rule has not needed bending once: a service gets
-- `expired` only where something can actually end it. Marketplace has a
-- duration and an active_to, events have a date they happen on, highlights
-- have start and end dates. Articles and gallery submissions are published and
-- stay published.
--
-- articles also keeps `draft`, which no other submission has: it is the only
-- service where a member can save unsent work.
--
-- WHY THIS IS SAFE TO RE-RUN
--
-- Migrations execute on every deploy, and changing a CHECK re-validates the
-- whole table each time. Every value an existing row could hold is kept — all
-- five originals, draft included — and only new ones are added. Nothing is
-- renamed.

ALTER TABLE articles DROP CONSTRAINT IF EXISTS articles_status_check;
ALTER TABLE articles ADD CONSTRAINT articles_status_check
  CHECK (status IN (
    'draft', 'awaiting_payment', 'pending', 'approved', 'rejected',
    'changes_requested', 'resubmitted', 'credit_issued'
  ));
