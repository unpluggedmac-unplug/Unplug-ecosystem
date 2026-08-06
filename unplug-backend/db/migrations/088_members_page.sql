-- Members, Profile Social Interaction & Community System — Phase 5:
-- the Members page backend.
--
-- No new "member" concept — an approved Directory profile IS a member
-- listing (individual or business, per profiles.type), same definition
-- Directory already uses. This adds only what's missing to support the
-- brief's card fields and filters: a featured flag (nothing like it
-- existed — grepped profiles/business_status_levels/site settings
-- before writing this) and one function joining together data that
-- already exists across profiles/score_cache/member_status_history/
-- momentum_scores/member_follows/content_reactions.

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_featured BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_profiles_featured ON profiles(is_featured) WHERE is_featured = TRUE;

-- =============================================================
-- GET_MEMBERS — one query backing every filter/sort combination the
-- Members page needs. p_sort values: 'trending' (momentum_index),
-- 'newest' (account creation), 'most_followed', 'highest_ranked'
-- (Unplug Score), 'featured' (is_featured = TRUE, still ranked by
-- score), 'random'. Anything else falls back to newest-first.
-- =============================================================
CREATE OR REPLACE FUNCTION get_members(
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
  total_likes     INTEGER
) AS $$
  SELECT
    p.id, p.user_id, p.slug, p.display_name, p.feature_image_url, p.type,
    c.name, p.province, p.verified, p.is_featured,
    COALESCE(sc.unplug_score, 0),
    sl.code, sl.label, sl.emoji,
    COALESCE((SELECT COUNT(*) FROM member_follows WHERE followed_user_id = p.user_id), 0)::INTEGER,
    COALESCE((SELECT COUNT(*) FROM content_reactions WHERE target_type = 'profile' AND target_id = p.id AND reaction = 'like'), 0)::INTEGER
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
  ORDER BY
    CASE WHEN p_sort = 'trending'      THEN COALESCE(ms.momentum_index, 0) END DESC NULLS LAST,
    CASE WHEN p_sort = 'newest'        THEN u.created_at END DESC NULLS LAST,
    CASE WHEN p_sort = 'most_followed' THEN (SELECT COUNT(*) FROM member_follows WHERE followed_user_id = p.user_id) END DESC NULLS LAST,
    CASE WHEN p_sort = 'highest_ranked' THEN COALESCE(sc.unplug_score, 0) END DESC NULLS LAST,
    CASE WHEN p_sort = 'featured'      THEN COALESCE(sc.unplug_score, 0) END DESC NULLS LAST,
    CASE WHEN p_sort = 'random'        THEN RANDOM() END,
    p.created_at DESC
  LIMIT p_limit OFFSET p_offset;
$$ LANGUAGE SQL STABLE;
