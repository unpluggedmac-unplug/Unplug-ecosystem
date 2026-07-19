-- "Save for later" reading list. One row per (member, article); the primary
-- key makes saving twice a no-op instead of creating duplicates, so the
-- frontend can fire save/unsave without checking first.
CREATE TABLE IF NOT EXISTS saved_articles (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  saved_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, article_id)
);

-- The list is always read "my saves, newest first".
CREATE INDEX IF NOT EXISTS saved_articles_user_idx
  ON saved_articles (user_id, saved_at DESC);
