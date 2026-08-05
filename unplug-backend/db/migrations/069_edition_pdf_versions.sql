-- A record of every edition PDF that has been replaced.
--
-- Replacing an edition's PDF overwrites editions.pdf_url, and the previous
-- address is then gone from the database — even though the file itself still
-- exists in storage. If a corrected file turns out to be the wrong one, or a
-- buyer queries what they were sold, there was no way to find the old one.
--
-- This only records the swap. It deliberately does NOT delete the old file:
-- customers who bought before the replacement may still be mid-download, and
-- deleting storage objects from a migration is not something to do quietly.
CREATE TABLE IF NOT EXISTS edition_pdf_versions (
  id           SERIAL PRIMARY KEY,
  edition_id   INTEGER NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
  pdf_url      VARCHAR(500) NOT NULL,   -- the file that was REPLACED
  replaced_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  replaced_by  INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_edition_pdf_versions_edition
  ON edition_pdf_versions (edition_id, replaced_at DESC);
