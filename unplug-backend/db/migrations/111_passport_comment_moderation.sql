-- Deaf passport comments now wait for an admin, like every other comment.
--
-- This was the one comment surface on the site with no moderation at all.
-- content_comments (articles, profiles, gallery, events, marketplace) has
-- defaulted to 'pending' since it was built, and its public read filters to
-- approved. Passport comments had no status column, and the POST that creates
-- them is fully anonymous — no account needed, just a rate limit and a
-- honeypot. So anyone on the internet could put text on a live public page
-- with nothing standing between them and a reader.
--
-- EXISTING COMMENTS ARE SET TO 'pending', NOT 'approved'.
--
-- That is deliberate, and it is the disruptive choice, so it is worth being
-- explicit about. Those comments are public right now and this will hide them
-- until an admin reviews them. The alternative — grandfathering them in as
-- approved — would leave unvetted anonymous text public, which is the exact
-- thing this migration exists to stop. Nothing is deleted: every one appears
-- in the Approval Queue and can be approved back in seconds.

ALTER TABLE deaf_passport_comments ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'pending';
ALTER TABLE deaf_passport_comments DROP CONSTRAINT IF EXISTS deaf_passport_comments_status_check;
ALTER TABLE deaf_passport_comments ADD CONSTRAINT deaf_passport_comments_status_check
  CHECK (status IN ('pending', 'approved', 'rejected'));

ALTER TABLE deaf_passport_comments ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE deaf_passport_comments ADD COLUMN IF NOT EXISTS reviewed_by INTEGER
  REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_deaf_passport_comments_status
  ON deaf_passport_comments (status, created_at DESC);
