-- Admin notifications for everything, not just consultant payments.
--
-- The table already existed with one writer. These columns are what it needs
-- to carry the rest of the site without becoming unreadable.
--
--   dedupe_key    groups repeats. When an UNREAD notification with the same
--                 key already exists, the new event increments it instead of
--                 adding a row: "7 new comments awaiting approval" rather than
--                 seven lines. NULL means never roll up — a new member or a
--                 payment is worth its own row every time.
--
--   event_count   how many times that rolled-up thing has happened.
--
--   detail        context that does not belong in the one-line message: the
--                 error text, the route, who submitted it.
--
--   link_section  which admin section to open. A notification you cannot act
--                 on from is a notification you have to go hunting after.
--
--   last_seen_at  when the most recent one arrived, as opposed to created_at
--                 which stays at the first.
--
-- ROLL-UP ONLY INTO UNREAD ROWS. Once an admin has read "7 new comments", the
-- eighth starts a fresh row rather than quietly re-opening the one they just
-- dealt with. That is the difference between a running tally and a
-- notification that never goes away.
ALTER TABLE admin_notifications ADD COLUMN IF NOT EXISTS dedupe_key   VARCHAR(120);
ALTER TABLE admin_notifications ADD COLUMN IF NOT EXISTS event_count  INTEGER NOT NULL DEFAULT 1;
ALTER TABLE admin_notifications ADD COLUMN IF NOT EXISTS detail       TEXT;
ALTER TABLE admin_notifications ADD COLUMN IF NOT EXISTS link_section VARCHAR(40);
ALTER TABLE admin_notifications ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

-- Backfill so existing rows sort and render consistently with new ones.
UPDATE admin_notifications SET last_seen_at = created_at WHERE last_seen_at IS NULL;

-- The lookup the roll-up does on every notify: "is there an unread one with
-- this key?". Partial, because read rows are never rolled into.
CREATE UNIQUE INDEX IF NOT EXISTS admin_notifications_open_dedupe
  ON admin_notifications (dedupe_key) WHERE read = false AND dedupe_key IS NOT NULL;

-- Reading the list is always "unread first, newest first".
CREATE INDEX IF NOT EXISTS admin_notifications_feed
  ON admin_notifications (read, last_seen_at DESC);
