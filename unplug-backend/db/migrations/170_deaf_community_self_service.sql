-- Deaf Community jobs and Opportunity Passports get a self-service manage
-- link. Website remediation punch-list, PASSPORT-002/DEAF-003.
--
-- Neither table has a user_id: submitting has never required an account,
-- which matters for an accessibility-focused feature and is kept exactly as
-- it is. So "prove it's yours" is an emailed link, not a login — the same
-- shape as the edition-download claim flow (email + a random token), except
-- the token is reusable (a member may come back to edit or renew more than
-- once) rather than single-use.
ALTER TABLE deaf_jobs ADD COLUMN IF NOT EXISTS manage_token VARCHAR(64) UNIQUE;
ALTER TABLE deaf_passports ADD COLUMN IF NOT EXISTS manage_token VARCHAR(64) UNIQUE;

-- Minted lazily, in application code, at first request — same as
-- editionAccess.js's generateToken() for downloads, and for the same reason:
-- a token should not exist before it's needed. This also avoids a SQL-side
-- crypto dependency (gen_random_bytes needs the pgcrypto extension, which
-- nothing in this project has ever enabled) for a value plain Node crypto
-- already generates correctly elsewhere. A row submitted before this
-- migration is manageable the first time its owner requests a link, exactly
-- like a row submitted after.

-- "Deactivate" and "delete" from the punch list are treated as one action —
-- an immediate, permanent removal from the live board — rather than a
-- separate dormant state, since nothing asked for a way to bring a
-- deactivated listing back. A genuine "pending"/"approved"/"rejected" row
-- can still reach here; 'withdrawn' is the fourth state, owner-only, never
-- set by moderation.
ALTER TABLE deaf_jobs DROP CONSTRAINT IF EXISTS deaf_jobs_status_check;
ALTER TABLE deaf_jobs ADD CONSTRAINT deaf_jobs_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn'));
ALTER TABLE deaf_passports DROP CONSTRAINT IF EXISTS deaf_passports_status_check;
ALTER TABLE deaf_passports ADD CONSTRAINT deaf_passports_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn'));
