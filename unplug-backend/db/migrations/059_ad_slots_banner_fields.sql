-- Extend the existing centralized banner system (ad_slots) with optional
-- advertiser-facing fields. All nullable (metadata-only, never rewrites the
-- table) so this can't fail on existing rows.
ALTER TABLE ad_slots ADD COLUMN IF NOT EXISTS name             VARCHAR(160); -- admin label / advertiser name
ALTER TABLE ad_slots ADD COLUMN IF NOT EXISTS cta_text         VARCHAR(40);  -- optional CTA button text
ALTER TABLE ad_slots ADD COLUMN IF NOT EXISTS mobile_image_url TEXT;         -- optional narrower crop for small screens
