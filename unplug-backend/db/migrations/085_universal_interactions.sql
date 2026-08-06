-- Members, Profile Social Interaction & Community System — Phase 1:
-- Universal Interaction Engine.
--
-- Investigated first (per the brief's own instruction): no like/dislike
-- mechanism exists anywhere in this codebase today (comments have a
-- 4-emoji reaction set with no negative option, scoped to comments
-- only); "reply" functionality was never built, so there is nothing to
-- remove from the frontend/backend/database — this migration IS that
-- confirmation, on the record; saves are hard-scoped to articles via
-- `saved_articles`.
--
-- One polymorphic pair of tables, not six per-type tables — same
-- target_type/target_id pattern gallery_images.owner_type/owner_id
-- already uses in this codebase (002_profiles.sql), extended to cover
-- every content type the brief lists: article, profile (covers both
-- individual and business listings — profiles.type already
-- distinguishes them, no separate table exists or is needed),
-- gallery_image, event, marketplace_listing.
--
-- Likes/dislikes are ONE row per (user, target) with a reaction column,
-- not two separate tables — this is what makes "never both active
-- simultaneously" true by construction rather than an app-layer rule
-- that could drift out of sync.

CREATE TABLE IF NOT EXISTS content_reactions (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type  VARCHAR(20) NOT NULL CHECK (target_type IN ('article', 'profile', 'gallery_image', 'event', 'marketplace_listing')),
  target_id    INTEGER NOT NULL,
  reaction     VARCHAR(10) NOT NULL CHECK (reaction IN ('like', 'dislike')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS idx_content_reactions_target ON content_reactions(target_type, target_id, reaction);
CREATE INDEX IF NOT EXISTS idx_content_reactions_user ON content_reactions(user_id);

CREATE TABLE IF NOT EXISTS content_saves (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type  VARCHAR(20) NOT NULL CHECK (target_type IN ('article', 'profile', 'gallery_image', 'event', 'marketplace_listing')),
  target_id    INTEGER NOT NULL,
  saved_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS idx_content_saves_target ON content_saves(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_content_saves_user ON content_saves(user_id, saved_at DESC);

DROP TRIGGER IF EXISTS trg_content_reactions_updated_at ON content_reactions;
CREATE TRIGGER trg_content_reactions_updated_at BEFORE UPDATE ON content_reactions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================
-- MIGRATE — carry every existing saved_articles row into content_saves
-- (target_type='article'), then retire the old table. ON CONFLICT DO
-- NOTHING makes this safe to re-run every deploy: after the first run,
-- saved_articles no longer exists, so the INSERT...SELECT is a no-op
-- against an empty/absent source (guarded by IF EXISTS below).
-- =============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'saved_articles') THEN
    INSERT INTO content_saves (user_id, target_type, target_id, saved_at)
    SELECT user_id, 'article', article_id, saved_at FROM saved_articles
    ON CONFLICT (user_id, target_type, target_id) DO NOTHING;

    DROP TABLE saved_articles;
  END IF;
END $$;

-- =============================================================
-- COUNTS — public stat display (❤️👎🔖 today; 💬 joins in once Phase 2
-- generalises comments to every content type — until then this counts
-- comments only for target_type='article' against the existing
-- article_comments table, which is the only comment table that exists
-- yet).
-- =============================================================
CREATE OR REPLACE FUNCTION get_content_stats(p_target_type TEXT, p_target_id INTEGER)
RETURNS TABLE (likes INTEGER, dislikes INTEGER, comments INTEGER, saves INTEGER) AS $$
  SELECT
    (SELECT COUNT(*) FROM content_reactions WHERE target_type = p_target_type AND target_id = p_target_id AND reaction = 'like')::INTEGER,
    (SELECT COUNT(*) FROM content_reactions WHERE target_type = p_target_type AND target_id = p_target_id AND reaction = 'dislike')::INTEGER,
    (SELECT COUNT(*) FROM article_comments WHERE p_target_type = 'article' AND article_id = p_target_id AND status = 'approved')::INTEGER,
    (SELECT COUNT(*) FROM content_saves WHERE target_type = p_target_type AND target_id = p_target_id)::INTEGER;
$$ LANGUAGE SQL STABLE;
