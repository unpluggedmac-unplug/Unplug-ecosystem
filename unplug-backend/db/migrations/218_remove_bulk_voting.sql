-- Remove the retired bulk-voting purchase system while preserving normal individual votes.
-- Normal votes are the rows not associated with vote_bundles. Bulk-only vote rows
-- are removed before the bulk schema is dropped; ordinary vote rows are untouched.

-- Remove financial rows for the retired product before tightening the linked-type constraint.
DELETE FROM payments WHERE linked_type = 'vote_bundle';

-- Remove only vote rows created by a bulk purchase. Normal individual votes have
-- vote_bundle_id IS NULL and are intentionally preserved.
DELETE FROM votes WHERE vote_bundle_id IS NOT NULL;

-- Rebuild normal-vote uniqueness/rate-limit indexes without a bulk-only predicate.
DROP INDEX IF EXISTS idx_votes_bundle;
DROP INDEX IF EXISTS idx_votes_once_user;
DROP INDEX IF EXISTS idx_votes_once_session;
DROP INDEX IF EXISTS idx_votes_daily_user;
DROP INDEX IF EXISTS idx_votes_daily_session;
DROP INDEX IF EXISTS idx_votes_daily_count;
DROP INDEX IF EXISTS idx_votes_daily_count_session;

ALTER TABLE votes DROP COLUMN IF EXISTS vote_bundle_id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_votes_once_user
  ON votes (entry_id, voter_user_id)
  WHERE voter_user_id IS NOT NULL AND vote_day IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_votes_once_session
  ON votes (entry_id, session_id)
  WHERE voter_user_id IS NULL AND vote_day IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_votes_daily_user
  ON votes (entry_id, voter_user_id, vote_day)
  WHERE voter_user_id IS NOT NULL AND vote_day IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_votes_daily_session
  ON votes (entry_id, session_id, vote_day)
  WHERE voter_user_id IS NULL AND vote_day IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_votes_daily_count
  ON votes (voter_user_id, vote_day)
  WHERE vote_day IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_votes_daily_count_session
  ON votes (session_id, vote_day)
  WHERE vote_day IS NOT NULL;

DROP TABLE IF EXISTS vote_bundle_tiers;
DROP TABLE IF EXISTS vote_bundles;
DELETE FROM settings WHERE key = 'bundle_vote_price';

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_linked_type_check;
ALTER TABLE payments ADD CONSTRAINT payments_linked_type_check
  CHECK (linked_type IN ('profile_package', 'profile_upgrade', 'competition_entry',
                         'highlight', 'marketplace_listing',
                         'article_publish', 'event_listing', 'gallery_bundle',
                         'top10_entry', 'edition_download', 'ad_banner',
                         'form_payment', 'agreement_payment'));
