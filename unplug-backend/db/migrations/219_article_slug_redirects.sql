-- Permanent history for published article slugs.
--
-- Shared links can live for years. When an editor deliberately changes an
-- article slug, the old public URL must keep resolving to the same article
-- rather than becoming a 404 or, worse, being reused by another story.
CREATE TABLE IF NOT EXISTS article_slug_redirects (
  id BIGSERIAL PRIMARY KEY,
  article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  old_slug VARCHAR(96) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS article_slug_redirects_article_id_idx
  ON article_slug_redirects(article_id);
