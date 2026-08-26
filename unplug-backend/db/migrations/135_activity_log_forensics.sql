-- The audit trail gains the two facts it was missing, and the indexes that
-- make it searchable.
--
-- WHAT IT RECORDED BEFORE: who, what, when. That answers "was this approved?"
-- but not the question you actually ask when something has gone wrong, which
-- is "where was that done from, and was it really them?". An admin account
-- used from an address it has never been used from before is the whole signal.
--
-- WHY THE COLUMNS ARE NULLABLE. Seventy-eight call sites already write to this
-- table, and every existing row predates these columns. A NOT NULL with a
-- backfilled default would be inventing an address for actions whose origin
-- nobody knows — worse than an honest blank, because it looks like evidence.
--
-- Reversal: the columns can be dropped; nothing reads them without a NULL
-- guard, and the log works exactly as it did before.

ALTER TABLE admin_activity_log ADD COLUMN IF NOT EXISTS ip_address TEXT;
ALTER TABLE admin_activity_log ADD COLUMN IF NOT EXISTS user_agent TEXT;

-- Marks the actions worth being told about rather than finding later: role
-- changes, deletions, refunds, anything that removes a safeguard. Set by the
-- application from a list it keeps, not by a rule here, because "high risk"
-- is a judgement that will change and a CHECK constraint would need a
-- migration every time it did.
ALTER TABLE admin_activity_log ADD COLUMN IF NOT EXISTS high_risk BOOLEAN NOT NULL DEFAULT false;

-- Searching. The log is read in exactly three ways: newest first, filtered to
-- one admin, or filtered to one kind of action — and increasingly, all three
-- at once with a date range.
CREATE INDEX IF NOT EXISTS idx_activity_log_admin   ON admin_activity_log (admin_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_log_action  ON admin_activity_log (action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_log_ip      ON admin_activity_log (ip_address) WHERE ip_address IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_activity_log_risk    ON admin_activity_log (created_at DESC) WHERE high_risk;

-- Free-text search across the action and its details.
--
-- pg_trgm rather than a tsvector: the useful searches here are fragments of
-- names and identifiers — "Nkosi", "#412", part of an email — and full-text
-- search stems and tokenises words, which is the wrong tool for matching the
-- middle of an identifier. Trigram indexes make ILIKE '%fragment%' fast, which
-- is exactly the query being run.
--
-- The extension may not be available on every managed Postgres. If it is not,
-- the search still works; it simply scans. Wrapped so a missing extension can
-- never fail a deploy — every migration in this codebase re-runs on every
-- deploy, so a hard failure here would block all of them for ever.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE INDEX IF NOT EXISTS idx_activity_log_search
    ON admin_activity_log USING gin ((action || ' ' || COALESCE(details, '')) gin_trgm_ops);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_trgm unavailable — activity log search will scan instead of using an index (%)', SQLERRM;
END $$;
