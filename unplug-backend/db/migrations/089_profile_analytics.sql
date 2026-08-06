-- Members, Profile Social Interaction & Community System — Phase 6:
-- Public vs Private Profile Analytics.
--
-- Every field below maps to a real, already-existing table. Three
-- honest exceptions, called out here rather than guessed at silently:
--
--  1. "Badges Earned" vs "Achievements Earned" — this schema (Stage C)
--     has exactly one such concept: achievements/user_achievements.
--     There is no separate badges table. Both fields report the same
--     count; a future stage would need to actually build a distinct
--     badges system for these to diverge.
--  2. "Competitions Won" — hall_of_fame (033_hall_of_fame.sql) is the
--     only record of past winners, and it stores a free-text `name`
--     typed in by an admin with no user_id/profile_id column at all.
--     There is no reliable way to compute this per-member from existing
--     data — fuzzy name-matching would risk showing the wrong person's
--     win. Always returns 0 until hall_of_fame gains a real linkage.
--  3. "Reading / Community / Business / Creator Contributions" — the
--     brief names these without defining them against this specific
--     schema. Reading = comments authored (the one reading-adjacent
--     action this schema tracks per-user). Community = total
--     participation actions (score_cache.total_actions — literally
--     "how many things has this person done"). Business = approved
--     reviews received on their own Directory listing (only meaningful
--     when profile.type = 'business', NULL otherwise). Creator =
--     articles + gallery images + events published, summed.

-- =============================================================
-- PUBLIC — what any signed-in visitor (a follower or not) can see.
-- Deliberately excludes anything privacy-sensitive; see interactions.js/
-- profiles.js for what already never appears in a public payload
-- (phone, email, physical address).
-- =============================================================
CREATE OR REPLACE FUNCTION get_public_profile_analytics(p_user_id INTEGER)
RETURNS TABLE (
  unplug_score              INTEGER,
  status_code               VARCHAR,
  status_label              VARCHAR,
  status_emoji              VARCHAR,
  current_ranking           INTEGER,
  followers                 INTEGER,
  following                 INTEGER,
  articles_published        INTEGER,
  gallery_images_published  INTEGER,
  events_published          INTEGER,
  competitions_entered      INTEGER,
  competitions_won          INTEGER,
  passport_completion_pct   INTEGER,
  badges_earned             INTEGER,
  achievements_earned       INTEGER,
  recognition_received      INTEGER,
  profile_likes             INTEGER,
  profile_dislikes          INTEGER,
  profile_reviews           INTEGER,
  profile_saves             INTEGER,
  reading_contributions     INTEGER,
  community_contributions   INTEGER,
  business_contributions    INTEGER,
  creator_contributions     INTEGER,
  current_streak_days       INTEGER
) AS $$
DECLARE
  v_profile_id INTEGER;
  v_profile_type VARCHAR;
BEGIN
  SELECT id, type INTO v_profile_id, v_profile_type FROM profiles WHERE user_id = p_user_id ORDER BY id LIMIT 1;

  RETURN QUERY
  SELECT
    COALESCE(sc.unplug_score, 0),
    sl.code, sl.label, sl.emoji,
    r.rank_position,
    fc.followers, fc.following,
    (SELECT COUNT(*) FROM articles WHERE author_user_id = p_user_id AND status = 'approved')::INTEGER,
    (SELECT COUNT(*) FROM gallery_images WHERE owner_type = 'profile' AND owner_id = v_profile_id AND status = 'approved')::INTEGER,
    (SELECT COUNT(*) FROM events WHERE organizer_user_id = p_user_id AND status = 'approved')::INTEGER,
    (SELECT COUNT(*) FROM competition_entries ce JOIN profiles pr ON pr.id = ce.profile_id WHERE pr.user_id = p_user_id AND ce.status = 'approved')::INTEGER,
    0, -- competitions_won — see note above; hall_of_fame has no user linkage
    CASE WHEN pit.total > 0 THEN ROUND((pit.earned::NUMERIC / pit.total) * 100)::INTEGER ELSE 0 END,
    (SELECT COUNT(*) FROM user_achievements WHERE user_id = p_user_id)::INTEGER, -- badges_earned: see note above, same source as achievements
    (SELECT COUNT(*) FROM user_achievements WHERE user_id = p_user_id)::INTEGER,
    COALESCE(rc.total_received, 0),
    (SELECT COUNT(*) FROM content_reactions WHERE target_type = 'profile' AND target_id = v_profile_id AND reaction = 'like')::INTEGER,
    (SELECT COUNT(*) FROM content_reactions WHERE target_type = 'profile' AND target_id = v_profile_id AND reaction = 'dislike')::INTEGER,
    (SELECT COUNT(*) FROM profile_reviews WHERE profile_id = v_profile_id AND status = 'approved')::INTEGER,
    (SELECT COUNT(*) FROM content_saves WHERE target_type = 'profile' AND target_id = v_profile_id)::INTEGER,
    (SELECT COUNT(*) FROM content_comments WHERE user_id = p_user_id AND status = 'approved')::INTEGER,
    COALESCE(sc.total_actions, 0),
    CASE WHEN v_profile_type = 'business' THEN (SELECT COUNT(*) FROM profile_reviews WHERE profile_id = v_profile_id AND status = 'approved')::INTEGER ELSE NULL END,
    (
      (SELECT COUNT(*) FROM articles WHERE author_user_id = p_user_id AND status = 'approved') +
      (SELECT COUNT(*) FROM gallery_images WHERE owner_type = 'profile' AND owner_id = v_profile_id AND status = 'approved') +
      (SELECT COUNT(*) FROM events WHERE organizer_user_id = p_user_id AND status = 'approved')
    )::INTEGER,
    COALESCE(us.current_streak_days, 0)
  FROM (SELECT 1) dummy
  LEFT JOIN score_cache sc ON sc.user_id = p_user_id
  LEFT JOIN member_status_history msh ON msh.user_id = p_user_id AND msh.is_active_status = TRUE
  LEFT JOIN member_status_levels sl ON sl.code = msh.status_code
  LEFT JOIN rankings r ON r.user_id = p_user_id AND r.ranking_type = 'overall' AND r.period_type = 'lifetime' AND r.period_value = 'all-time'
  LEFT JOIN recognition_counts rc ON rc.user_id = p_user_id
  LEFT JOIN user_streaks us ON us.user_id = p_user_id
  CROSS JOIN LATERAL (SELECT * FROM get_follow_counts(p_user_id)) fc
  CROSS JOIN LATERAL (
    SELECT COUNT(*) FILTER (WHERE up.user_id IS NOT NULL) AS earned, COUNT(*) AS total
      FROM passport_items pi LEFT JOIN user_passport up ON up.passport_code = pi.code AND up.user_id = p_user_id
     WHERE pi.is_enabled = TRUE
  ) pit;
END;
$$ LANGUAGE plpgsql STABLE;
