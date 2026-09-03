-- Who did it: staff, or the member themselves.
--
-- admin_activity_log has recorded ~95 kinds of ADMIN action since it was built.
-- It is now also the record of what members SUBMIT, so that the monthly account
-- of activity shows what came in as well as what was decided about it.
--
-- The actor column is called admin_user_id, and renaming it would touch every
-- one of the 117 places that write to this table for no gain. What was missing
-- is not a second id column but the answer to "was this us or them", which is
-- this.
--
-- EXISTING ROWS ARE BACKFILLED TO 'admin', and that is accurate rather than
-- assumed: every action recorded before this migration was written by an
-- admin-only route. Leaving them NULL would make a report have to guess.
ALTER TABLE admin_activity_log ADD COLUMN IF NOT EXISTS actor_role VARCHAR(10);

-- THE ORDER OF THE NEXT THREE STATEMENTS MATTERS.
--
-- Render runs the migration while the PREVIOUS instance is still serving, so
-- for a few seconds old code — which does not name this column — is still
-- inserting rows. The default goes on FIRST so those inserts are recorded as
-- 'admin' (which is what they are) instead of arriving blank behind the
-- backfill and tripping the NOT NULL that follows.
ALTER TABLE admin_activity_log ALTER COLUMN actor_role SET DEFAULT 'admin';

UPDATE admin_activity_log SET actor_role = 'admin' WHERE actor_role IS NULL;

-- Complete, not merely usually filled in. A record that is allowed to say
-- nothing about who acted is one that will, eventually, say nothing.
ALTER TABLE admin_activity_log ALTER COLUMN actor_role SET NOT NULL;

ALTER TABLE admin_activity_log DROP CONSTRAINT IF EXISTS admin_activity_log_actor_role_check;
ALTER TABLE admin_activity_log ADD CONSTRAINT admin_activity_log_actor_role_check
  CHECK (actor_role IN ('admin', 'member', 'system'));

-- The monthly report reads a calendar month and groups by who acted, so both
-- go in the index. created_at already has one of its own for the live screen.
CREATE INDEX IF NOT EXISTS idx_activity_log_month
  ON admin_activity_log (created_at DESC, actor_role);

COMMENT ON COLUMN admin_activity_log.actor_role IS
  'admin = staff action, member = the member''s own submission, system = a scheduled job. Backfilled to admin: every row before migration 167 came from an admin-only route.';
