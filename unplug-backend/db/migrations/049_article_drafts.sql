-- Drafts, and a chosen publish date.
--
-- Two gaps in the article flow.
--
-- 1. An admin writing an article had only "Publish Live" — no way to save a
-- half-finished piece without it going straight onto the site. 'draft' is a
-- new status that is saved but never shown publicly (the public feed already
-- filters to status = 'approved', so a draft is invisible with no other
-- change). Adding it to the CHECK constraint is all the database needs.
ALTER TABLE articles DROP CONSTRAINT IF EXISTS articles_status_check;
ALTER TABLE articles ADD CONSTRAINT articles_status_check
  CHECK (status IN ('draft', 'awaiting_payment', 'pending', 'approved', 'rejected'));

-- 2. When approving a member's submission, an admin may want it to go live on a
-- particular day rather than the instant it's approved. scheduled_for records
-- that date. The article is marked 'approved' on approval, but the public feed
-- additionally requires scheduled_for to be null or already past — so a
-- future-dated article stays hidden until its day and then appears on its own,
-- with no scheduled job needed (Render's free tier has no cron). The moment
-- CURRENT_DATE catches up, the same query that hid it now shows it.
ALTER TABLE articles ADD COLUMN IF NOT EXISTS scheduled_for DATE;
