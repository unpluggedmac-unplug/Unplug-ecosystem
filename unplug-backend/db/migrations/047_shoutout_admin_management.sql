-- Shout-out management: a waiting period, and admin-created entries.
--
-- Two changes to how a nomination reaches the homepage.

-- 1. A waiting period. Approving a nomination no longer means it can appear
-- the same day. Nominations sit for seven days first, which gives time to
-- notice a name that was submitted maliciously or in poor taste before it is
-- on the front page, and spaces the queue out instead of burning through a
-- batch of approvals in a rush.
--
-- Existing rows are backdated from their own created_at rather than from
-- today: anything already submitted a week ago has served the wait, and
-- resetting the clock on the current queue would blank the section.
ALTER TABLE shoutout_nominations
  ADD COLUMN IF NOT EXISTS available_from DATE;

UPDATE shoutout_nominations
   SET available_from = (created_at::date + 7)
 WHERE available_from IS NULL;

ALTER TABLE shoutout_nominations
  ALTER COLUMN available_from SET DEFAULT (CURRENT_DATE + 7);
ALTER TABLE shoutout_nominations
  ALTER COLUMN available_from SET NOT NULL;

-- 2. Where the entry came from. An admin adding a name directly is not making
-- a nomination that needs reviewing — it is already the editorial decision —
-- so those skip the wait. Recording the source keeps the two apart in the
-- admin list, so a public submission can never be mistaken for a name staff
-- chose.
ALTER TABLE shoutout_nominations
  ADD COLUMN IF NOT EXISTS source VARCHAR(10) NOT NULL DEFAULT 'public';
ALTER TABLE shoutout_nominations DROP CONSTRAINT IF EXISTS shoutout_nominations_source_check;
ALTER TABLE shoutout_nominations ADD CONSTRAINT shoutout_nominations_source_check
  CHECK (source IN ('public', 'admin'));

-- The daily pick reads approved-and-available in submission order; this is the
-- index for exactly that.
CREATE INDEX IF NOT EXISTS idx_shoutout_nominations_queue
  ON shoutout_nominations (status, available_from, created_at);
