-- View counts for gallery images (and every other content type the
-- universal interaction engine already covers).
--
-- The interaction bar could already show likes/dislikes/comments/saves but
-- never views, because nothing recorded them — page_views (017) tracks SPA
-- page paths, not individual items.
--
-- Deduped per viewer per DAY rather than per-ever or per-request:
--   - per-request would let a refresh inflate the count without limit;
--   - per-ever would make "views" mean "unique viewers", which is a
--     different (and much smaller) number than people expect next to an eye
--     icon, and would never grow for a loyal returning audience.
-- One-per-day is the same shape as daily voting (098) and is the common
-- convention. The day is South African for the same reason it is there:
-- Render runs UTC, so a UTC day would roll over at 02:00 local.

CREATE TABLE IF NOT EXISTS content_views (
  id          SERIAL PRIMARY KEY,
  target_type VARCHAR(30) NOT NULL,
  target_id   INTEGER NOT NULL,
  -- Signed-in viewer when known, else the guest's session id. Nullable
  -- user_id (not CASCADE-deleted to zero) so removing an account does not
  -- silently rewrite historical view counts.
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  session_id  VARCHAR(120),
  view_day    DATE NOT NULL DEFAULT (now() AT TIME ZONE 'Africa/Johannesburg')::date,
  viewed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (user_id IS NOT NULL OR session_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_content_views_target
  ON content_views (target_type, target_id);

-- One view per signed-in viewer per item per day.
CREATE UNIQUE INDEX IF NOT EXISTS idx_content_views_daily_user
  ON content_views (target_type, target_id, user_id, view_day)
  WHERE user_id IS NOT NULL;

-- One view per guest session per item per day.
CREATE UNIQUE INDEX IF NOT EXISTS idx_content_views_daily_session
  ON content_views (target_type, target_id, session_id, view_day)
  WHERE user_id IS NULL;

-- get_content_stats gains a `views` column.
--
-- DROP first, not CREATE OR REPLACE: the return signature changes, and
-- Postgres refuses to replace a function whose RETURNS TABLE differs. The
-- same trap that would have broken award_badge in 099.
DROP FUNCTION IF EXISTS get_content_stats(TEXT, INTEGER);

CREATE OR REPLACE FUNCTION get_content_stats(p_target_type TEXT, p_target_id INTEGER)
RETURNS TABLE (likes INTEGER, dislikes INTEGER, comments INTEGER, saves INTEGER, views INTEGER) AS $$
  SELECT
    (SELECT COUNT(*) FROM content_reactions WHERE target_type = p_target_type AND target_id = p_target_id AND reaction = 'like')::INTEGER,
    (SELECT COUNT(*) FROM content_reactions WHERE target_type = p_target_type AND target_id = p_target_id AND reaction = 'dislike')::INTEGER,
    (SELECT COUNT(*) FROM content_comments  WHERE target_type = p_target_type AND target_id = p_target_id AND status = 'approved')::INTEGER,
    (SELECT COUNT(*) FROM content_saves     WHERE target_type = p_target_type AND target_id = p_target_id)::INTEGER,
    (SELECT COUNT(*) FROM content_views     WHERE target_type = p_target_type AND target_id = p_target_id)::INTEGER;
$$ LANGUAGE SQL STABLE;
