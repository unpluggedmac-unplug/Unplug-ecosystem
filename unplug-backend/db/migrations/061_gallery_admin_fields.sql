-- Admin Gallery Management: extends the EXISTING gallery_images table (used by
-- both member photo submissions and admin-added images) rather than creating a
-- second gallery system. All new columns are nullable with no default, so this
-- is a fast metadata-only change that can never fail on existing rows.
--
-- `status` (awaiting_payment/pending/approved/rejected) is untouched — it keeps
-- governing the member-submission payment/moderation queue exactly as before.
-- `visibility` is the NEW, separate admin publish control described in the
-- spec (draft/published/unpublished/archived). NULL means "no admin visibility
-- override" — an approved member photo with no visibility set still shows, so
-- nothing existing changes behaviour.
ALTER TABLE gallery_images ADD COLUMN IF NOT EXISTS title         VARCHAR(200);
ALTER TABLE gallery_images ADD COLUMN IF NOT EXISTS alt_text      VARCHAR(255);
ALTER TABLE gallery_images ADD COLUMN IF NOT EXISTS link_url      TEXT;
ALTER TABLE gallery_images ADD COLUMN IF NOT EXISTS link_type     VARCHAR(20);
ALTER TABLE gallery_images ADD COLUMN IF NOT EXISTS display_order INTEGER;
ALTER TABLE gallery_images ADD COLUMN IF NOT EXISTS visibility    VARCHAR(20);
ALTER TABLE gallery_images ADD COLUMN IF NOT EXISTS updated_at    TIMESTAMPTZ;
ALTER TABLE gallery_images ADD COLUMN IF NOT EXISTS updated_by    INTEGER REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_gallery_images_order ON gallery_images (display_order);
