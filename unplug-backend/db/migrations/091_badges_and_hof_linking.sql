-- Members, Profile Social Interaction & Community System — follow-up
-- fixes: real "competitions won" data + a genuine Badges system,
-- distinct from Achievements.

-- =============================================================
-- 1. HALL OF FAME — optional link to a real account. Existing rows stay
-- untouched (NULL — "apart from the ones already", per the site owner's
-- own instruction); an admin can set this per-entry going forward, same
-- edit form as everything else on this table (competitions.js PATCH
-- /hall-of-fame/:id already supports partial updates).
-- =============================================================
ALTER TABLE hall_of_fame ADD COLUMN IF NOT EXISTS linked_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_hall_of_fame_linked_user ON hall_of_fame(linked_user_id) WHERE linked_user_id IS NOT NULL;

-- get_public_profile_analytics() (089) is re-declared below with the
-- real count wired in, replacing the "always 0" placeholder.

-- =============================================================
-- 2. BADGES — a real second progression track, not achievements
-- relabelled. Deliberately admin-granted only (no trigger_config/
-- auto-unlock engine like achievements has) — a badge here means
-- someone in particular decided to recognise this member for
-- something, the same spirit as Recognition (Stage C) but a lasting
-- visual mark on the profile rather than a one-off point transaction.
-- =============================================================
CREATE TABLE IF NOT EXISTS badges (
  code          VARCHAR(60) PRIMARY KEY,
  label         VARCHAR(120) NOT NULL,
  description   TEXT NOT NULL,
  emoji         VARCHAR(10) NOT NULL,
  category      VARCHAR(30) NOT NULL DEFAULT 'general',
  is_enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_badges (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  badge_code    VARCHAR(60) NOT NULL REFERENCES badges(code) ON DELETE CASCADE,
  awarded_by    INTEGER REFERENCES users(id),
  reason        TEXT,
  awarded_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, badge_code)
);
CREATE INDEX IF NOT EXISTS idx_user_badges_user ON user_badges(user_id);

-- A starter set an admin can edit/disable/extend from the admin panel —
-- not a hardcoded final list, same "seed, don't hardcode" pattern as
-- every other stage's seed data this session.
INSERT INTO badges (code, label, description, emoji, category, sort_order) VALUES
  ('founding_member',     'Founding Member',     'One of the earliest members of the Unplug community.',    '🌟', 'community',    1),
  ('community_champion',  'Community Champion',  'Recognised for outstanding contribution to the community.', '🏅', 'community',    2),
  ('editors_pick',        'Editor''s Pick',      'Content or contribution personally highlighted by Unplug editorial.', '✨', 'editorial',   3),
  ('rising_star_badge',   'Rising Star',         'Standout growth and engagement in a short time.',          '🚀', 'achievement',  4),
  ('event_mvp',           'Event MVP',           'Outstanding participation at an Unplug event.',            '🏆', 'event',        5)
ON CONFLICT (code) DO NOTHING;

CREATE OR REPLACE FUNCTION award_badge(p_user_id INTEGER, p_badge_code TEXT, p_awarded_by INTEGER, p_reason TEXT DEFAULT NULL)
RETURNS BOOLEAN AS $$
DECLARE
  v_badge badges%ROWTYPE;
  v_inserted BOOLEAN;
BEGIN
  SELECT * INTO v_badge FROM badges WHERE code = p_badge_code AND is_enabled = TRUE;
  IF NOT FOUND THEN RETURN FALSE; END IF;

  INSERT INTO user_badges (user_id, badge_code, awarded_by, reason)
  VALUES (p_user_id, p_badge_code, p_awarded_by, p_reason)
  ON CONFLICT (user_id, badge_code) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF NOT v_inserted THEN RETURN FALSE; END IF;

  INSERT INTO notifications (user_id, type, title, body, link_url)
  VALUES (p_user_id, 'badge', v_badge.emoji || ' Badge earned: ' || v_badge.label,
    COALESCE(p_reason, v_badge.description), '/unplug-member-dashboard.html');

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

-- =============================================================
-- 3. PUBLIC PROFILE ANALYTICS — re-declared with real data for both
-- fields that were previously a placeholder/duplicate:
--   - badges_earned now counts user_badges (a genuinely separate
--     number from achievements_earned)
--   - competitions_won now counts hall_of_fame rows actually linked to
--     this user_id — 0 for anyone with no linked win, same as before,
--     but a real number once an admin links one
-- Everything else is unchanged from 089_profile_analytics.sql.
-- =============================================================
CREATE OR REPLACE FUNCTION get_public_profile_analytics(p_user_id INTEGER)
RETURNS TABLE (
  unplug_score              INTEGER,
  status_code               VARCHAR,
  status_label               VARCHAR,
  status_emoji               VARCHAR,
  current_ranking            INTEGER,
  followers                  INTEGER,
  following                  INTEGER,
  articles_published         INTEGER,
  gallery_images_published   INTEGER,
  events_published           INTEGER,
  competitions_entered       INTEGER,
  competitions_won           INTEGER,
  passport_completion_pct    INTEGER,
  badges_earned              INTEGER,
  achievements_earned        INTEGER,
  recognition_received       INTEGER,
  profile_likes              INTEGER,
  profile_dislikes           INTEGER,
  profile_reviews            INTEGER,
  profile_saves              INTEGER,
  reading_contributions      INTEGER,
  community_contributions    INTEGER,
  business_contributions     INTEGER,
  creator_contributions       INTEGER,
  current_streak_days        INTEGER
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
    (SELECT COUNT(*) FROM hall_of_fame WHERE linked_user_id = p_user_id)::INTEGER,
    CASE WHEN pit.total > 0 THEN ROUND((pit.earned::NUMERIC / pit.total) * 100)::INTEGER ELSE 0 END,
    (SELECT COUNT(*) FROM user_badges WHERE user_id = p_user_id)::INTEGER,
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
