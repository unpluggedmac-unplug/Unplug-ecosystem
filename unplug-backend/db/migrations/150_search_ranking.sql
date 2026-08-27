-- 150: real search — relevance ranking and typo tolerance.
--
-- Site search was `ILIKE '%term%'`, ordered by publication date. Two things
-- were wrong with that beyond speed:
--
--   1. NO RELEVANCE. An article whose TITLE is the search term ranked below a
--      newer one that mentions it once in the last paragraph. The reader has
--      to read the whole list to find the obvious answer.
--   2. NO TOLERANCE. "fashon" found nothing. "running" did not find "run".
--
-- Full-text search fixes both: it stems ("run" matches "running"), and
-- ts_rank lets the title count for more than the body. pg_trgm covers the
-- typo case separately, because stemming does not help somebody who
-- misspelled the word.
--
-- These are EXPRESSION indexes, not new columns. Nothing about either table
-- changes, no rewrite happens on deploy, and the indexes are only used when a
-- query happens to spell the expression the same way — which search.js does,
-- deliberately, and there is a test that fails if the two drift apart.

-- Every migration here re-runs on every deploy, so an unavailable extension
-- must never be able to fail one — it would block every later migration for
-- ever. Same defensive shape as 135.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_trgm unavailable — "did you mean" suggestions will be skipped (%)', SQLERRM;
END $$;

-- ---------------------------------------------------------------------------
-- The full-text indexes, wrapped for the same reason as the extension above.
--
-- to_tsvector('english', ...) needs the server's tsearch_data/english.stop to
-- exist. Every real Postgres has it; some cut-down builds do not — the
-- embedded-postgres bundle the tests run against ships that directory with the
-- hunspell samples and nothing else. An unwrapped CREATE INDEX there would
-- fail the migration, and because `npm start` is `migrate && node app.js`, a
-- failed migration is not a degraded search — it is the API never starting.
-- A slow search beats a site that is down.
--
-- The failure is NOISY on purpose. If these indexes are ever missing in
-- production the searches still return correct answers, they just read every
-- article body on the site to do it, and nothing else would ever say so.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  -- The expression MUST match the WHERE clause in routes/search.js character
  -- for character, or Postgres will not use the index. There is a test that
  -- plans the real query and fails if they drift.
  CREATE INDEX IF NOT EXISTS idx_articles_fts
    ON articles USING gin (to_tsvector('english',
         coalesce(title, '') || ' ' ||
         coalesce(subtitle, '') || ' ' ||
         coalesce(meta_description, '') || ' ' ||
         coalesce(body, '')));

  CREATE INDEX IF NOT EXISTS idx_profiles_fts
    ON profiles USING gin (to_tsvector('english',
         coalesce(display_name, '') || ' ' ||
         coalesce(bio, '') || ' ' ||
         coalesce(achievements, '') || ' ' ||
         coalesce(career, '') || ' ' ||
         coalesce(quote, '')));

  CREATE INDEX IF NOT EXISTS idx_my_unplug_fts
    ON my_unplug_profiles USING gin (to_tsvector('english',
         coalesce(display_name, '') || ' ' ||
         coalesce(username, '') || ' ' ||
         coalesce(about_me, '')));
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FULL-TEXT SEARCH INDEXES NOT CREATED — site search will scan every row. This Postgres cannot run to_tsvector(''english'', ...): %', SQLERRM;
END $$;

-- ------------------------------------------------------------ typo support
-- Only the names people actually mistype are indexed for trigrams. Indexing
-- whole article bodies this way would be a large index earning very little:
-- "did you mean" is answered from titles and names, not from paragraph three.
DO $$
BEGIN
  CREATE INDEX IF NOT EXISTS idx_articles_title_trgm
    ON articles USING gin (title gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS idx_profiles_name_trgm
    ON profiles USING gin (display_name gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS idx_editions_title_trgm
    ON editions USING gin (title gin_trgm_ops);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'trigram indexes skipped — pg_trgm is not installed (%)', SQLERRM;
END $$;

-- Editions are searched by title only and there are a handful of them; a
-- plain index is enough and an FTS index would never pay for itself.
CREATE INDEX IF NOT EXISTS idx_editions_published
  ON editions (published_at DESC);
