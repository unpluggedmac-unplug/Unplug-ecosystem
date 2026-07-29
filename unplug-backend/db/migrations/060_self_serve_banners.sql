-- Self-serve banner advertising: a member/business can buy a banner for a
-- placement (7/14/28 days), pay through the existing checkout, then an admin
-- approves it before it goes live. Extends the existing ad_slots table — all
-- columns nullable (metadata-only, never rewrites the table). Admin-created
-- banners keep owner_user_id/moderation_status NULL and are treated as approved.
ALTER TABLE ad_slots ADD COLUMN IF NOT EXISTS owner_user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE ad_slots ADD COLUMN IF NOT EXISTS moderation_status VARCHAR(20);  -- pending_payment | pending_approval | approved | rejected (NULL = admin-created = live)
ALTER TABLE ad_slots ADD COLUMN IF NOT EXISTS payment_id        INTEGER REFERENCES payments(id) ON DELETE SET NULL;
ALTER TABLE ad_slots ADD COLUMN IF NOT EXISTS duration_days     SMALLINT;

CREATE INDEX IF NOT EXISTS idx_ad_slots_owner ON ad_slots (owner_user_id);

-- Allow 'ad_banner' as a payment linked_type. Kept as the full superset in ALL
-- copies of this constraint (008/010/011) so no redeploy re-validation fails.
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_linked_type_check;
ALTER TABLE payments ADD CONSTRAINT payments_linked_type_check
  CHECK (linked_type IN ('profile_package', 'profile_upgrade', 'competition_entry', 'highlight', 'marketplace_listing', 'vote_bundle', 'article_publish', 'event_listing', 'gallery_bundle', 'top10_entry', 'edition_download', 'ad_banner'));
