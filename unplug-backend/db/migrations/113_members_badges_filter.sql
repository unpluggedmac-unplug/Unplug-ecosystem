-- A "Badges" filter on the Members page: every member who has been awarded a
-- badge, most-decorated first.
--
-- Two changes to get_members, and one of them needs care:
--
-- 1. A new `badged` sort. It is BOTH a filter and an order — unlike the other
--    sorts, which only reorder the same set, this one narrows to members who
--    actually hold a badge. A member with none must never appear under it.
--
-- 2. badge_count is added to the returned columns so a card can show how many
--    a member holds without a second query per member.
--
-- Adding a return column means CREATE OR REPLACE is not enough: Postgres
-- refuses to change a function's return type in place, so the function is
-- dropped and recreated. That is only safe because 088_members_page.sql is
-- the ONLY file that defines get_members — nothing added to it later is lost
-- by the drop. Verified before writing this.
--
-- The count is COUNT(*) over user_badges, not COUNT(DISTINCT badge_code):
-- since migration 099 the same badge can be awarded for different months, and
-- each of those is a real award the member earned.
--
-- Deliberately scoped to the Members page. Badge holders are NOT added to the
-- Competitions page — competitions list entrants and winners, which is a
-- different thing from everyone who has ever been given a badge.

DROP FUNCTION IF EXISTS get_members(TEXT, INTEGER, TEXT, TEXT, TEXT, INTEGER, INTEGER);

CREATE FUNCTION get_members(
  p_search   TEXT    DEFAULT NULL,
  p_category INTEGER DEFAULT NULL,
  p_province TEXT    DEFAULT NULL,
  p_type     TEXT    DEFAULT NULL,
  p_sort     TEXT    DEFAULT 'newest',
  p_limit    INTEGER DEFAULT 24,
  p_offset   INTEGER DEFAULT 0
)
RETURNS TABLE (
  profile_id      INTEGER,
  user_id         INTEGER,
  slug            VARCHAR,
  display_name    VARCHAR,
  feature_image_url TEXT,
  type            VARCHAR,
  category        VARCHAR,
  province        VARCHAR,
  verified        BOOLEAN,
  is_featured     BOOLEAN,
  unplug_score    INTEGER,
  status_code     VARCHAR,
  status_label    VARCHAR,
  status_emoji    VARCHAR,
  followers       INTEGER,
  total_likes     INTEGER,
  badge_count     INTEGER
) AS $$
  SELECT
    p.id, p.user_id, p.slug, p.display_name, p.feature_image_url, p.type,
    c.name, p.province, p.verified, p.is_featured,
    COALESCE(sc.unplug_score, 0),
    sl.code, sl.label, sl.emoji,
    COALESCE((SELECT COUNT(*) FROM member_follows WHERE followed_user_id = p.user_id), 0)::INTEGER,
    COALESCE((SELECT COUNT(*) FROM content_reactions WHERE target_type = 'profile' AND target_id = p.id AND reaction = 'like'), 0)::INTEGER,
    COALESCE((SELECT COUNT(*) FROM user_badges WHERE user_id = p.user_id), 0)::INTEGER
  FROM profiles p
  LEFT JOIN categories c ON c.id = p.category_id
  LEFT JOIN score_cache sc ON sc.user_id = p.user_id
  LEFT JOIN member_status_history msh ON msh.user_id = p.user_id AND msh.is_active_status = TRUE
  LEFT JOIN member_status_levels sl ON sl.code = msh.status_code
  LEFT JOIN momentum_scores ms ON ms.user_id = p.user_id
  LEFT JOIN users u ON u.id = p.user_id
  WHERE p.status = 'approved'
    AND (p_search IS NULL OR p.display_name ILIKE '%' || p_search || '%')
    AND (p_category IS NULL OR p.category_id = p_category)
    AND (p_province IS NULL OR p.province = p_province)
    AND (p_type IS NULL OR p.type = p_type)
    AND (p_sort != 'featured' OR p.is_featured = TRUE)
    -- The badged filter. EXISTS rather than a join, so a member holding
    -- forty badges is still one row.
    AND (p_sort != 'badged' OR EXISTS (SELECT 1 FROM user_badges ub WHERE ub.user_id = p.user_id))
  ORDER BY
    CASE WHEN p_sort = 'trending'      THEN COALESCE(ms.momentum_index, 0) END DESC NULLS LAST,
    CASE WHEN p_sort = 'newest'        THEN u.created_at END DESC NULLS LAST,
    CASE WHEN p_sort = 'most_followed' THEN (SELECT COUNT(*) FROM member_follows WHERE followed_user_id = p.user_id) END DESC NULLS LAST,
    CASE WHEN p_sort = 'highest_ranked' THEN COALESCE(sc.unplug_score, 0) END DESC NULLS LAST,
    CASE WHEN p_sort = 'featured'      THEN COALESCE(sc.unplug_score, 0) END DESC NULLS LAST,
    CASE WHEN p_sort = 'badged'        THEN (SELECT COUNT(*) FROM user_badges ub WHERE ub.user_id = p.user_id) END DESC NULLS LAST,
    CASE WHEN p_sort = 'random'        THEN RANDOM() END,
    p.created_at DESC
  LIMIT p_limit OFFSET p_offset;
$$ LANGUAGE SQL STABLE;

-- The badged filter and its ordering both count a member's badges, so this is
-- the index both lean on.
CREATE INDEX IF NOT EXISTS idx_user_badges_user ON user_badges (user_id);
