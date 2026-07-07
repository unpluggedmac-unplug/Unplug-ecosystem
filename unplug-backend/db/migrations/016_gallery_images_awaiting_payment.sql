-- Fixes a real bug found while testing the gallery bundle batch-insert fix:
-- gallery_images.status was created with CHECK (status IN ('pending',
-- 'approved', 'rejected')) in 002_profiles.sql, but POST /gallery (added
-- alongside the payment flow in 010_new_pricing_model.sql) inserts
-- 'awaiting_payment' — every gallery bundle submission has been failing
-- this constraint since that flow was written.

ALTER TABLE gallery_images DROP CONSTRAINT IF EXISTS gallery_images_status_check;
ALTER TABLE gallery_images ADD CONSTRAINT gallery_images_status_check
  CHECK (status IN ('awaiting_payment', 'pending', 'approved', 'rejected'));
