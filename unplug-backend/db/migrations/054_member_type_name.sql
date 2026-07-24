-- Membership type and name captured at registration.
--
-- Registration now asks whether the member is an Individual or a Business, and
-- takes their full/business name up front. Previously an account was only an
-- email + password, and the name lived on a Directory profile that most members
-- never created. Storing it on the account means we can greet them properly and
-- pre-fill their name when they do create a listing.
ALTER TABLE users ADD COLUMN IF NOT EXISTS member_type VARCHAR(20);
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_member_type_check;
ALTER TABLE users ADD CONSTRAINT users_member_type_check
  CHECK (member_type IS NULL OR member_type IN ('individual', 'business'));

ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name VARCHAR(160);
