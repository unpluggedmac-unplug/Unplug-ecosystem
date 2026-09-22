-- Legacy WordPress imports need a user row because profiles.user_id is
-- NOT NULL and ON DELETE CASCADE. These are content-owner records, not real
-- members, so mark them as internal system accounts rather than deleting them.
-- This preserves every imported profile and its dependent content while
-- removing the synthetic accounts from member/account administration.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_system_account BOOLEAN NOT NULL DEFAULT false;

UPDATE users
   SET is_system_account = true,
       is_suspended = true,
       suspended_reason = COALESCE(
         suspended_reason,
         'Internal legacy-content owner; hidden from member/account administration.'
       )
 WHERE email ILIKE '%@import.unplugnews.com';

CREATE INDEX IF NOT EXISTS idx_users_system_account
  ON users (is_system_account)
  WHERE is_system_account = true;
