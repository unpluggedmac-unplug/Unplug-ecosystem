-- TAGS ON DIRECTORY LISTINGS AND MY UNPLUG PROFILES.
--
-- articles already carried tags (042). These are the same idea for the other
-- two things people own: a Directory listing describes what a business does,
-- a My Unplug profile describes who a member is, and neither could say so in
-- words a reader could search for.
--
-- The two tables stay separate, as 105 sets out at length — a Directory
-- listing and a community identity are different things and share only
-- users.id. Each therefore gets its own column rather than a shared tag table
-- keyed by a polymorphic type, which would be the first step towards
-- forgetting they are different.
--
-- TEN IS ENFORCED HERE, not just in the API. Three separate routes can write
-- these columns (owner, admin, and the member dashboard), plus the backfill.
-- A limit that lives in application code is a limit that one of those four
-- paths eventually forgets.

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS tags TEXT[];
ALTER TABLE my_unplug_profiles ADD COLUMN IF NOT EXISTS tags TEXT[];

-- DROP then ADD so the rule can be corrected later: migrations re-run on every
-- deploy, and ADD CONSTRAINT IF NOT EXISTS does not exist in PostgreSQL.
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_tags_max;
ALTER TABLE profiles ADD CONSTRAINT profiles_tags_max
  CHECK (tags IS NULL OR cardinality(tags) <= 10);

ALTER TABLE my_unplug_profiles DROP CONSTRAINT IF EXISTS my_unplug_profiles_tags_max;
ALTER TABLE my_unplug_profiles ADD CONSTRAINT my_unplug_profiles_tags_max
  CHECK (tags IS NULL OR cardinality(tags) <= 10);

-- articles gets the same ceiling. It had none, so a bulk edit could have put
-- fifty words under "Topics in this story".
ALTER TABLE articles DROP CONSTRAINT IF EXISTS articles_tags_max;
ALTER TABLE articles ADD CONSTRAINT articles_tags_max
  CHECK (tags IS NULL OR cardinality(tags) <= 10);

-- Site search asks "which rows carry this tag", which is a containment test
-- over an array — exactly what GIN indexes. Without these, search would fall
-- back to scanning every listing on every keystroke.
CREATE INDEX IF NOT EXISTS idx_profiles_tags ON profiles USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_my_unplug_tags ON my_unplug_profiles USING GIN (tags);
