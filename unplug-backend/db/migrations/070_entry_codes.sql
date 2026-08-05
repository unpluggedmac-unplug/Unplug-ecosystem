-- A strictly 10-digit unique code on every APPROVED competition entry (Top 10
-- and any other competition), so a voter can identify an entry by a short
-- code rather than a database id, and use it when buying bulk votes.
--
-- Generated automatically the moment an entry becomes 'approved' — enforced by
-- a trigger rather than application code, because there are THREE separate
-- places in this codebase that can move an entry to 'approved': the admin
-- approval-queue endpoint (PATCH /admin/entries/:id/approve), the Top 10
-- entries editor's direct status change (PATCH /entries/:id), and an
-- admin-added entry that is inserted as 'approved' immediately (POST
-- /competitions/:id/admin-entries). Adding "generate a code" to each of those
-- individually is exactly the kind of thing a future fourth call site would
-- forget to do. A trigger cannot be forgotten.
ALTER TABLE competition_entries ADD COLUMN IF NOT EXISTS entry_code VARCHAR(10);

-- Strictly 10 digits, numeric only — matches what was asked for exactly,
-- rather than the mixed letter/number scheme used elsewhere in this codebase.
ALTER TABLE competition_entries DROP CONSTRAINT IF EXISTS competition_entries_entry_code_format;
ALTER TABLE competition_entries ADD CONSTRAINT competition_entries_entry_code_format
  CHECK (entry_code IS NULL OR entry_code ~ '^[0-9]{10}$');

-- The real uniqueness guarantee. The generator avoids collisions itself, but
-- this index is what actually prevents two entries ever sharing a code, even
-- under a concurrent race the generator's own check could miss. Partial (WHERE
-- entry_code IS NOT NULL) because every not-yet-approved entry has NULL and
-- NULLs must not collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS idx_competition_entries_code
  ON competition_entries (entry_code) WHERE entry_code IS NOT NULL;

-- Assigns a code the moment a row's status is (or becomes) 'approved' and it
-- doesn't have one yet. Fires on INSERT (an admin-added entry is created
-- already 'approved' — no separate UPDATE ever happens for it) and on UPDATE
-- (the normal member-entry approval flow, and the Top 10 editor's direct
-- status change). Never overwrites an existing code, and never touches a
-- rejected/pending/awaiting_payment entry — a code only exists for something
-- that can actually receive votes.
CREATE OR REPLACE FUNCTION assign_entry_code() RETURNS trigger AS $$
DECLARE
  candidate VARCHAR(10);
  attempt INTEGER := 0;
BEGIN
  IF NEW.status = 'approved' AND NEW.entry_code IS NULL THEN
    LOOP
      -- floor(random() * 10^10) gives 0..9999999999; lpad keeps leading
      -- zeros so the code is always exactly 10 characters, e.g. 0004821037.
      candidate := lpad(floor(random() * 10000000000)::bigint::text, 10, '0');
      attempt := attempt + 1;
      EXIT WHEN attempt > 30 OR NOT EXISTS (
        SELECT 1 FROM competition_entries WHERE entry_code = candidate
      );
    END LOOP;
    NEW.entry_code := candidate;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- No CREATE OR REPLACE TRIGGER — that syntax needs PostgreSQL 14+, and this
-- must not assume a server version. DROP then CREATE is the portable
-- equivalent and is idempotent, which matters: this migration re-runs on
-- every deploy.
DROP TRIGGER IF EXISTS trg_assign_entry_code ON competition_entries;
CREATE TRIGGER trg_assign_entry_code
  BEFORE INSERT OR UPDATE ON competition_entries
  FOR EACH ROW EXECUTE FUNCTION assign_entry_code();

-- Backfill: every entry that is ALREADY approved on the live site today needs
-- a code too, not only new approvals from here on. Re-writing status to its
-- own value fires the same BEFORE UPDATE trigger above for each such row, so
-- the backfill uses the exact same generation logic as new approvals rather
-- than a second, potentially-diverging copy of it. Naturally idempotent: once
-- a row has a code, it no longer matches entry_code IS NULL, so re-running
-- this on the next deploy does nothing further.
UPDATE competition_entries
   SET status = status
 WHERE status = 'approved' AND entry_code IS NULL;
