-- Members, Profile Social Interaction & Community System — Phase 2:
-- Comments generalised to every content type.
--
-- article_comments/article_comment_reactions (Stage W2, 036) become
-- content_comments/content_comment_reactions, same polymorphic
-- target_type/target_id pattern Phase 1 already established for
-- reactions/saves. No reply/thread column existed before this and none
-- is added now — flat comments only, per the brief.
--
-- Comment reactions keep their existing 4-emoji set (like/love/clap/
-- insightful) — the brief's "Like/Dislike" requirement is about the
-- CONTENT ITEM (article/profile/gallery image/etc, handled by
-- content_reactions in Phase 1), not about reacting to an individual
-- comment, which was never binary to begin with. Left unchanged
-- deliberately.

CREATE TABLE IF NOT EXISTS content_comments (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type  VARCHAR(20) NOT NULL CHECK (target_type IN ('article', 'profile', 'gallery_image', 'event', 'marketplace_listing')),
  target_id    INTEGER NOT NULL,
  body         TEXT NOT NULL,
  status       VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_content_comments_target ON content_comments(target_type, target_id, status);
CREATE INDEX IF NOT EXISTS idx_content_comments_status ON content_comments(status, created_at);

CREATE TABLE IF NOT EXISTS content_comment_reactions (
  comment_id  INTEGER NOT NULL REFERENCES content_comments(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reaction    TEXT NOT NULL CHECK (reaction IN ('like', 'love', 'clap', 'insightful')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (comment_id, user_id)
);

-- =============================================================
-- MIGRATE — carry every existing article_comments/article_comment_reactions
-- row across with explicit ids preserved (so reaction FKs still line up),
-- then retire the old tables. Guarded the same way Phase 1 guarded
-- saved_articles: safe to re-run every deploy.
-- =============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'article_comments') THEN
    INSERT INTO content_comments (id, user_id, target_type, target_id, body, status, created_at, reviewed_at)
    SELECT id, user_id, 'article', article_id, body, status, created_at, reviewed_at FROM article_comments
    ON CONFLICT (id) DO NOTHING;

    -- Keep the SERIAL sequence ahead of the migrated ids so the next
    -- INSERT never collides with one of the rows just copied in.
    PERFORM setval(pg_get_serial_sequence('content_comments', 'id'), COALESCE((SELECT MAX(id) FROM content_comments), 1));

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'article_comment_reactions') THEN
      INSERT INTO content_comment_reactions (comment_id, user_id, reaction, created_at)
      SELECT comment_id, user_id, reaction, now() FROM article_comment_reactions
      ON CONFLICT (comment_id, user_id) DO NOTHING;
      DROP TABLE article_comment_reactions;
    END IF;

    DROP TABLE article_comments;
  END IF;
END $$;

-- =============================================================
-- CONTENT STATS — re-declared with the deferred comment-count TODO from
-- Phase 1 filled in: counts content_comments for every target_type now,
-- not just 'article'.
-- =============================================================
-- This file's fix — counting content_comments for EVERY target_type rather
-- than only 'article' — is preserved verbatim in the current definition,
-- which now lives in 103_content_views.sql along with the added `views`
-- column.
--
-- It cannot also be declared here. Migrations re-run on every deploy, and
-- Postgres refuses a CREATE OR REPLACE that changes a function's return
-- type, so this 4-column version would fail against 103's 5-column one and
-- abort the migration run. Caught by test/contentViews.test.js.

-- =============================================================
-- TARGET TITLE — one human-readable label per content type, for the
-- admin moderation queue (was previously a straight article_title join;
-- now needs to work across 5 different source tables).
-- =============================================================
CREATE OR REPLACE FUNCTION get_target_title(p_target_type TEXT, p_target_id INTEGER)
RETURNS TEXT AS $$
  SELECT CASE p_target_type
    WHEN 'article'             THEN (SELECT title FROM articles WHERE id = p_target_id)
    WHEN 'profile'             THEN (SELECT display_name FROM profiles WHERE id = p_target_id)
    WHEN 'gallery_image'       THEN (SELECT COALESCE(caption, 'Image #' || p_target_id) FROM gallery_images WHERE id = p_target_id)
    WHEN 'event'                THEN (SELECT name FROM events WHERE id = p_target_id)
    WHEN 'marketplace_listing' THEN (SELECT headline FROM marketplace_listings WHERE id = p_target_id)
    ELSE NULL
  END;
$$ LANGUAGE SQL STABLE;
