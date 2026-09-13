-- Representative access, decoupled from `role`.
--
-- Until now, "Sales Consultant" was a value of `users.role` itself
-- (046_consultant_role.sql), which meant it was mutually exclusive with
-- every other role: granting Staff access to a representative overwrote
-- their role to 'staff' and silently suspended their representative access
-- (dashboard, free publishing) until Staff access was later removed. An
-- admin should be able to grant Representative access to ANY account —
-- member, staff, or even another admin — independent of whatever else that
-- account is. This migration makes that possible by moving representative
-- status into its own flag.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_representative BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS users_is_representative_idx ON users (is_representative) WHERE is_representative;

-- Backfill: every account currently holding the 'consultant' role becomes a
-- Representative and reverts to being a plain member — the role they would
-- have had if Representative access had always been a separate grant.
UPDATE users SET is_representative = true WHERE role = 'consultant';
UPDATE users SET role = 'member' WHERE role = 'consultant';

-- A staff assignment's original_role is what an account reverts to when
-- Staff access is removed (see routes/adminStaff.js). 'consultant' is no
-- longer a valid role to revert into — is_representative now survives the
-- Staff round-trip on its own, which is the point of this change.
UPDATE staff_assignments SET original_role = 'member' WHERE original_role = 'consultant';

-- 'consultant' is retired as a role value now that Representative access is
-- its own flag. This is re-run at every service startup (see
-- 046_consultant_role.sql's own note on this), so it must stay safe to run
-- again: DROP/ADD rather than a plain rename, and the two UPDATEs above have
-- already cleared every 'consultant' row by the time this runs.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('member', 'investor', 'advertiser', 'admin', 'staff'));
