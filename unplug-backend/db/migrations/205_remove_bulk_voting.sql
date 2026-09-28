-- Remove active bulk-voting infrastructure while preserving historical vote records.
-- Existing rows in votes are intentionally untouched. vote_bundles is retained only
-- as legacy financial/history data because votes.vote_bundle_id may still reference it.
BEGIN;

DELETE FROM settings WHERE key = 'bundle_vote_price';

DROP TABLE IF EXISTS vote_bundle_tiers;

-- Remove abandoned/unpaid bulk purchase records that never produced votes.
DELETE FROM vote_bundles vb
 WHERE vb.status IN ('awaiting_payment', 'rejected')
   AND NOT EXISTS (SELECT 1 FROM votes v WHERE v.vote_bundle_id = vb.id);

-- Prevent any new shared-payment row from being created for bulk voting while
-- tolerating historical payment rows already stored for audit/history.
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_linked_type_check;
ALTER TABLE payments ADD CONSTRAINT payments_linked_type_check
CHECK (linked_type IN (
  'profile_package','profile_upgrade','competition_entry','highlight',
  'marketplace_listing','article_publish','event_listing','gallery_bundle',
  'top10_entry','edition_download','ad_banner','form_payment','agreement_payment'
)) NOT VALID;

COMMENT ON TABLE vote_bundles IS
  'Legacy historical records only. Active bulk voting was removed 2026-09-28; no application route may create or mutate these rows.';

COMMIT;
