-- Remove the retired bulk-voting purchase system while preserving normal individual votes.
--
-- Two historical storage shapes exist:
--   1) newer paid-vote rows own vote_bundle_id and can be deleted exactly;
--   2) older purchases were merged into a normal vote row's bundle_size.
--      For those rows we subtract ONLY the confirmed purchased quantity. If a
--      normal individual vote was present before the purchase, its residual
--      value and row survive.

-- First unwind legacy confirmed purchases that do NOT have their own dedicated
-- vote_bundle_id row. Do this before deleting dedicated rows so the NOT EXISTS
-- test can distinguish the two historical shapes correctly.
WITH legacy_bulk AS (
  SELECT vb.entry_id,
         vb.buyer_user_id,
         vb.session_id,
         SUM(vb.vote_count)::integer AS bulk_count
    FROM vote_bundles vb
   WHERE vb.status = 'confirmed'
     AND NOT EXISTS (
       SELECT 1 FROM votes owned WHERE owned.vote_bundle_id = vb.id
     )
   GROUP BY vb.entry_id, vb.buyer_user_id, vb.session_id
)
DELETE FROM votes v
USING legacy_bulk lb
WHERE v.entry_id = lb.entry_id
  AND v.vote_bundle_id IS NULL
  AND v.vote_day IS NULL
  AND (
    (lb.buyer_user_id IS NOT NULL AND v.voter_user_id = lb.buyer_user_id)
    OR
    (lb.buyer_user_id IS NULL AND v.voter_user_id IS NULL AND v.session_id = lb.session_id)
  )
  AND v.bundle_size <= lb.bulk_count;

WITH legacy_bulk AS (
  SELECT vb.entry_id,
         vb.buyer_user_id,
         vb.session_id,
         SUM(vb.vote_count)::integer AS bulk_count
    FROM vote_bundles vb
   WHERE vb.status = 'confirmed'
     AND NOT EXISTS (
       SELECT 1 FROM votes owned WHERE owned.vote_bundle_id = vb.id
     )
   GROUP BY vb.entry_id, vb.buyer_user_id, vb.session_id
)
UPDATE votes v
   SET bundle_size = v.bundle_size - lb.bulk_count,
       payment_id = NULL
  FROM legacy_bulk lb
 WHERE v.entry_id = lb.entry_id
   AND v.vote_bundle_id IS NULL
   AND v.vote_day IS NULL
   AND v.bundle_size > lb.bulk_count
   AND (
     (lb.buyer_user_id IS NOT NULL AND v.voter_user_id = lb.buyer_user_id)
     OR
     (lb.buyer_user_id IS NULL AND v.voter_user_id IS NULL AND v.session_id = lb.session_id)
   );

-- Newer paid purchases have a dedicated row and can be removed exactly.
DELETE FROM votes WHERE vote_bundle_id IS NOT NULL;

-- Any remaining vote row carrying a bulk-payment foreign key is an individual
-- vote record that must survive; detach only the retired financial reference.
UPDATE votes
   SET payment_id = NULL
 WHERE payment_id IN (SELECT id FROM payments WHERE linked_type = 'vote_bundle');

-- Remove notification rows whose sole purpose was the retired purchase before
-- deleting their referenced payment rows (the FK is restrictive). Some older
-- databases/test fixtures predate notifications.related_payment_id, so access
-- it through to_jsonb() instead of referencing a potentially missing column.
-- This keeps the migration valid on both older fixtures and current production
-- without a procedural DO block.
DELETE FROM notifications n
 WHERE (to_jsonb(n) ->> 'related_payment_id') IN (
   SELECT id::text FROM payments WHERE linked_type = 'vote_bundle'
 );

-- Shared financial infrastructure remains; only records belonging to the
-- retired service are removed.
DELETE FROM payments WHERE linked_type = 'vote_bundle';

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
