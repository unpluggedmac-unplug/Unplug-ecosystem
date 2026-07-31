-- Monthly Editions — the fields the admin Editions screen needs.
--
-- 011_editions.sql created editions with just issue_number/title/cover/pdf/
-- price/published_at. Everything the Editions page and homepage want to show
-- (month, year, a description, a real publication date) and everything the
-- admin needs to control (status, ordering) is added here.
--
-- All columns are nullable or have defaults, so this is a metadata-only change
-- that cannot fail on a table with existing rows.
ALTER TABLE editions ADD COLUMN IF NOT EXISTS edition_number   VARCHAR(40);
ALTER TABLE editions ADD COLUMN IF NOT EXISTS month            VARCHAR(20);
ALTER TABLE editions ADD COLUMN IF NOT EXISTS year             INTEGER;
ALTER TABLE editions ADD COLUMN IF NOT EXISTS description      TEXT;
ALTER TABLE editions ADD COLUMN IF NOT EXISTS publication_date DATE;
ALTER TABLE editions ADD COLUMN IF NOT EXISTS status           VARCHAR(20);
ALTER TABLE editions ADD COLUMN IF NOT EXISTS display_order    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE editions ADD COLUMN IF NOT EXISTS created_at       TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE editions ADD COLUMN IF NOT EXISTS updated_at       TIMESTAMPTZ NOT NULL DEFAULT now();

-- Existing editions were all live, so they become 'published' and inherit
-- their publication date from published_at. Only fills blanks, so re-running
-- this migration (which happens on every deploy) never overwrites an admin's
-- later change of status or date.
UPDATE editions SET status = 'published' WHERE status IS NULL;
UPDATE editions SET publication_date = published_at::date WHERE publication_date IS NULL;
UPDATE editions SET year = EXTRACT(YEAR FROM published_at)::int WHERE year IS NULL;
UPDATE editions
   SET month = to_char(published_at, 'FMMonth')
 WHERE month IS NULL;

-- Applied after the backfill so no existing row can violate it.
ALTER TABLE editions ALTER COLUMN status SET DEFAULT 'published';
ALTER TABLE editions DROP CONSTRAINT IF EXISTS editions_status_check;
ALTER TABLE editions ADD CONSTRAINT editions_status_check
  CHECK (status IN ('draft', 'published', 'unpublished', 'archived'));

-- The public Editions page and the homepage both order by publication date.
CREATE INDEX IF NOT EXISTS idx_editions_status_date
  ON editions (status, publication_date DESC);
