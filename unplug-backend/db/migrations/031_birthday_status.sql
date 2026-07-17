-- Public can now submit birthdays (name, date, photo) for admin approval.
-- Existing admin-added birthdays default to 'approved' so they keep showing.
ALTER TABLE birthdays ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'approved';
ALTER TABLE birthdays DROP CONSTRAINT IF EXISTS birthdays_status_check;
ALTER TABLE birthdays ADD CONSTRAINT birthdays_status_check
  CHECK (status IN ('pending', 'approved', 'rejected'));
