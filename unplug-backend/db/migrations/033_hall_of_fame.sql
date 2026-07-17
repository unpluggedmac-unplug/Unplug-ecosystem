-- Competition "Hall of Fame" — past winners, entered by an admin (there is
-- no historical-winners data elsewhere in the schema, so this is the source
-- of truth for them).
CREATE TABLE IF NOT EXISTS hall_of_fame (
  id          SERIAL PRIMARY KEY,
  year        INTEGER,
  name        VARCHAR(200) NOT NULL,
  title       VARCHAR(200),          -- e.g. "The Face of Unplug" / category
  photo_url   TEXT,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hall_of_fame_year ON hall_of_fame (year DESC);
