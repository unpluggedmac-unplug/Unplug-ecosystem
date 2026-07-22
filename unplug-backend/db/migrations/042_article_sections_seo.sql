-- Richer articles: SEO fields, a conclusion and call to action, machine
-- derived metadata for an editor to review, and multi-section bodies.

-- Written by the author (or an editor).
ALTER TABLE articles ADD COLUMN IF NOT EXISTS seo_title        VARCHAR(255);
ALTER TABLE articles ADD COLUMN IF NOT EXISTS subtitle         VARCHAR(300);
ALTER TABLE articles ADD COLUMN IF NOT EXISTS meta_description VARCHAR(320);
ALTER TABLE articles ADD COLUMN IF NOT EXISTS conclusion       TEXT;
ALTER TABLE articles ADD COLUMN IF NOT EXISTS cta_label        VARCHAR(120);
ALTER TABLE articles ADD COLUMN IF NOT EXISTS cta_url          TEXT;

-- Derived from the text when the article is submitted. Stored rather than
-- recomputed on every read so an editor can correct them: the generator's
-- output is a first draft, and whatever the editor leaves here is what
-- actually publishes.
ALTER TABLE articles ADD COLUMN IF NOT EXISTS slug           VARCHAR(200);
ALTER TABLE articles ADD COLUMN IF NOT EXISTS key_takeaways  TEXT[];
ALTER TABLE articles ADD COLUMN IF NOT EXISTS keywords       TEXT[];
ALTER TABLE articles ADD COLUMN IF NOT EXISTS tags           TEXT[];
-- A suggestion only. category_id stays the real, admin-confirmed value.
ALTER TABLE articles ADD COLUMN IF NOT EXISTS suggested_category_id INTEGER REFERENCES categories(id);

-- Slugs must be unique to be usable as URLs, but existing rows have none,
-- so this is a partial index: NULLs are ignored and old articles keep working.
CREATE UNIQUE INDEX IF NOT EXISTS articles_slug_key
  ON articles (slug) WHERE slug IS NOT NULL;

-- Body sections. An article can be written as one body (the existing
-- `body` column) or as ordered sections; the renderer shows sections when
-- present and falls back to body otherwise, so nothing already published
-- changes.
CREATE TABLE IF NOT EXISTS article_sections (
  id          SERIAL PRIMARY KEY,
  article_id  INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL DEFAULT 0,
  sub_heading VARCHAR(255),
  paragraph   TEXT,
  image_url   TEXT,
  image_note  VARCHAR(255),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS article_sections_article_idx
  ON article_sections (article_id, position, id);
