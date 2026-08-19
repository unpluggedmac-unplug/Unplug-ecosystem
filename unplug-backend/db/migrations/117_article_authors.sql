-- WHO WROTE THIS. Articles had no author at all.
--
-- The only name on an article was `kicker_supplied_by`, whose field is
-- labelled "Supplied by (optional)" — that records who SENT the story in, not
-- who wrote it. The reader page printed "Submitted by Pierre Swanepoel", which
-- frames the journalism as user-generated submissions. Renaming that label
-- would have asserted authorship the data does not support, so an author is
-- added alongside it instead. The two facts stay separate and an article may
-- carry either, both, or neither.
--
-- TWO fields, deliberately:
--   author_name    — the byline as written. Always the text that is displayed.
--   contributor_id — an optional link to a full contributor profile.
-- A guest writing once needs a name and nothing else; a regular contributor
-- needs a page. Requiring a profile row for every one-off byline would mean
-- either refusing the byline or creating throwaway profiles.

CREATE TABLE IF NOT EXISTS contributors (
  id           SERIAL PRIMARY KEY,
  name         VARCHAR(160) NOT NULL,
  slug         VARCHAR(180) NOT NULL UNIQUE,
  role_title   VARCHAR(160),
  bio          TEXT,
  photo_url    TEXT,
  email        VARCHAR(255),
  -- Optional: a contributor is not necessarily an account holder, and an
  -- account holder is not necessarily a contributor.
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_contributors_active ON contributors (is_active);
CREATE INDEX IF NOT EXISTS idx_contributors_user ON contributors (user_id);

ALTER TABLE articles ADD COLUMN IF NOT EXISTS author_name VARCHAR(160);
-- ON DELETE SET NULL, not CASCADE: removing a contributor profile must never
-- delete their published work. The article keeps its author_name and simply
-- stops linking to a page.
ALTER TABLE articles ADD COLUMN IF NOT EXISTS contributor_id INTEGER
  REFERENCES contributors(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_articles_contributor ON articles (contributor_id);

DROP TRIGGER IF EXISTS trg_contributors_updated_at ON contributors;
CREATE TRIGGER trg_contributors_updated_at
  BEFORE UPDATE ON contributors
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
