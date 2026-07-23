-- Manual competition/Top 10 entries.
--
-- Until now every entry had to be a real Directory profile (profile_id NOT
-- NULL). An admin often wants to feature someone who has no profile on the
-- site — a name and a photo is all they have. This lets an entry carry its own
-- name and image instead of borrowing them from a profile.
ALTER TABLE competition_entries ADD COLUMN IF NOT EXISTS manual_name      VARCHAR(160);
ALTER TABLE competition_entries ADD COLUMN IF NOT EXISTS manual_image_url TEXT;

-- profile_id becomes optional. A profile-based entry still sets it; a manual
-- entry leaves it null and fills manual_name instead.
ALTER TABLE competition_entries ALTER COLUMN profile_id DROP NOT NULL;

-- Exactly one source of identity per row — never both, never neither — so a
-- row can always be displayed and nothing is ambiguous.
ALTER TABLE competition_entries DROP CONSTRAINT IF EXISTS competition_entries_identity_check;
ALTER TABLE competition_entries ADD CONSTRAINT competition_entries_identity_check
  CHECK ((profile_id IS NOT NULL AND manual_name IS NULL)
      OR (profile_id IS NULL AND manual_name IS NOT NULL));

-- The old UNIQUE (competition_id, profile_id) still applies to profile-based
-- entries. Postgres treats NULLs as distinct, so many manual entries with a
-- null profile_id coexist fine — no change needed there.
