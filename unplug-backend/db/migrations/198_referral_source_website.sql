-- "Website" as its own referral source, distinct from a specific social
-- platform or a consultant. The checkout dropdown already needed this;
-- payments.referral_source's CHECK constraint (from 007_sales_consultants.sql)
-- didn't allow it yet.

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_referral_source_check;
ALTER TABLE payments ADD CONSTRAINT payments_referral_source_check
  CHECK (referral_source IN ('google', 'facebook', 'instagram', 'linkedin', 'tiktok', 'sales_consultant', 'website', 'other'));
