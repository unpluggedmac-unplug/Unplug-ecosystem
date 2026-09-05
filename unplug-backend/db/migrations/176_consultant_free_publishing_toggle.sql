-- Free publishing for a consultant was all-or-nothing: the role itself
-- granted it, with no way to revoke it from one specific person without
-- demoting them out of the role entirely. Requested directly: let an admin
-- toggle it per consultant.
--
-- Stored on users generally (not consultant-specific) because that's where
-- role already lives, and the column is simply ignored for every other role
-- — same shape as is_suspended. Defaults to true so nothing changes for any
-- existing consultant until an admin deliberately turns it off for someone.
ALTER TABLE users ADD COLUMN IF NOT EXISTS free_publishing_enabled BOOLEAN NOT NULL DEFAULT true;
