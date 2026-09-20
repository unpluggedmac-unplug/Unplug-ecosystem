-- 217_gallery_bundle_cancellation_integrity.sql
--
-- Gallery payments and orders point at gallery_bundles.id. The cancellation
-- route historically pointed at gallery_images.id instead, so a gallery
-- cancellation could target the wrong row (or no row) and leave the paid
-- bundle itself active. Add the same cancellation marker used by the other
-- cancellable service records so the bundle is the single service identity.
ALTER TABLE gallery_bundles
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_gallery_bundles_cancelled_at
  ON gallery_bundles (cancelled_at)
  WHERE cancelled_at IS NOT NULL;
