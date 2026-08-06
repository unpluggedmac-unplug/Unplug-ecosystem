-- Participation Engine — Stage Q: weekly/monthly leaderboard scopes.
--
-- Stage D's rankings table already has period_type/period_value columns
-- (the schema was built for this), but every writer has only ever used
-- 'lifetime'/'all-time' — the "many scopes" leaderboard from the master
-- brief never got its weekly/monthly view. score_cache is a lifetime
-- cumulative total, so a period ranking can't be read from it the way
-- recalculate_ranking() reads lifetime ones — it's computed fresh from
-- participation_points, windowed to the current ISO week / calendar
-- month.
--
-- Also: no public page has ever rendered a leaderboard at all — Stage D
-- built get_leaderboard() but only the admin dashboard calls it. This
-- migration is the backend half; the member dashboard gets a real
-- Leaderboard tab in the same commit.

-- =============================================================
-- 1. PERIOD RANKING — overall/recognition/contribution only (momentum is
-- already an inherently "recent" measure — a weekly/monthly momentum
-- ranking would just be a slower, redundant copy of the same signal).
-- =============================================================
CREATE OR REPLACE FUNCTION recalculate_period_ranking(p_ranking_type TEXT, p_period_type TEXT)
RETURNS VOID AS $$
DECLARE
  v_period_value VARCHAR(20);
  v_start        TIMESTAMPTZ;
BEGIN
  IF p_period_type = 'weekly' THEN
    v_period_value := TO_CHAR(date_trunc('week', CURRENT_DATE), 'IYYY-"W"IW');
    v_start := date_trunc('week', CURRENT_DATE);
  ELSIF p_period_type = 'monthly' THEN
    v_period_value := TO_CHAR(CURRENT_DATE, 'YYYY-MM');
    v_start := date_trunc('month', CURRENT_DATE);
  ELSE
    RETURN; -- unsupported period_type — no-op rather than erroring, since
             -- this is called generically from recalculate_all_rankings()
  END IF;

  INSERT INTO rankings (user_id, ranking_type, period_type, period_value, rank_position, score_value, rank_movement, calculated_at)
  SELECT pp.user_id, p_ranking_type, p_period_type, v_period_value,
         ROW_NUMBER() OVER (ORDER BY SUM(pp.total_points) DESC)::INTEGER,
         SUM(pp.total_points)::INTEGER, 0, now()
    FROM participation_points pp
    JOIN participation_actions pa ON pa.code = pp.action_code
   WHERE pp.is_reversed = FALSE AND pp.earned_at >= v_start
     AND (
       p_ranking_type = 'overall'
       OR (p_ranking_type = 'recognition' AND pp.action_code IN ('recognition_give', 'recognition_receive'))
       OR (p_ranking_type = 'contribution' AND pa.counts_as_contribution = TRUE)
     )
   GROUP BY pp.user_id
  ON CONFLICT (user_id, ranking_type, period_type, period_value) DO UPDATE SET
    rank_position = EXCLUDED.rank_position,
    score_value   = EXCLUDED.score_value,
    calculated_at = now();
END;
$$ LANGUAGE plpgsql;

-- =============================================================
-- 2. RECALCULATE_ALL_RANKINGS — re-declared with weekly + monthly calls
-- added for the three period-eligible types. Lifetime calls unchanged
-- from Stage D's 075_rankings_homepage.sql.
-- =============================================================
CREATE OR REPLACE FUNCTION recalculate_all_rankings()
RETURNS VOID AS $$
BEGIN
  INSERT INTO ranking_history (user_id, ranking_type, period_type, period_value, rank_position, score_value)
  SELECT user_id, ranking_type, period_type, period_value, rank_position, score_value FROM rankings;

  PERFORM recalculate_momentum_scores();
  PERFORM recalculate_ranking('overall');
  PERFORM recalculate_ranking('momentum');
  PERFORM recalculate_ranking('recognition');
  PERFORM recalculate_ranking('contribution');

  PERFORM recalculate_period_ranking('overall', 'weekly');
  PERFORM recalculate_period_ranking('recognition', 'weekly');
  PERFORM recalculate_period_ranking('contribution', 'weekly');
  PERFORM recalculate_period_ranking('overall', 'monthly');
  PERFORM recalculate_period_ranking('recognition', 'monthly');
  PERFORM recalculate_period_ranking('contribution', 'monthly');
END;
$$ LANGUAGE plpgsql;

-- =============================================================
-- 3. GET_LEADERBOARD — re-declared with period_type/period_value
-- parameters, both defaulted so every existing caller (admin dashboard,
-- the old 3-arg signature) keeps working unchanged.
--
-- Postgres identifies a function by name AND parameter signature, so
-- CREATE OR REPLACE with a different parameter count does not replace
-- Stage D's original 3-arg version — it creates a second, overloaded
-- function. A 3-arg call then becomes ambiguous between "the real 3-arg
-- function" and "the 5-arg function with its last two defaulted",
-- caught by this migration's own test suite. The old signature must be
-- dropped explicitly first.
-- =============================================================
DROP FUNCTION IF EXISTS get_leaderboard(TEXT, INTEGER, INTEGER);

CREATE OR REPLACE FUNCTION get_leaderboard(
  p_ranking_type TEXT DEFAULT 'overall',
  p_limit INTEGER DEFAULT 50,
  p_offset INTEGER DEFAULT 0,
  p_period_type TEXT DEFAULT 'lifetime',
  p_period_value TEXT DEFAULT 'all-time'
)
RETURNS TABLE (
  rank_position  INTEGER,
  rank_movement  INTEGER,
  user_id        INTEGER,
  display_name   TEXT,
  avatar_url     TEXT,
  status_code    VARCHAR,
  status_label   VARCHAR,
  status_emoji   VARCHAR,
  score_value    INTEGER
) AS $$
  SELECT
    r.rank_position, r.rank_movement, u.id,
    COALESCE(dp.display_name, SPLIT_PART(u.email, '@', 1)),
    dp.feature_image_url,
    sl.code, sl.label, sl.emoji,
    r.score_value
  FROM rankings r
  JOIN users u ON u.id = r.user_id
  LEFT JOIN profiles dp ON dp.user_id = u.id AND dp.status = 'approved'
  LEFT JOIN member_status_history msh ON msh.user_id = u.id AND msh.is_active_status = TRUE
  LEFT JOIN member_status_levels sl ON sl.code = msh.status_code
  WHERE r.ranking_type = p_ranking_type AND r.period_type = p_period_type AND r.period_value = p_period_value
    AND COALESCE((SELECT show_on_leaderboard FROM member_participation_profiles mp WHERE mp.user_id = u.id), TRUE) = TRUE
  ORDER BY r.rank_position ASC
  LIMIT p_limit OFFSET p_offset;
$$ LANGUAGE SQL STABLE;

-- =============================================================
-- 4. CURRENT PERIOD LABELS — so the frontend/route never has to compute
-- the ISO-week or month label itself (avoids a repeat of the
-- date_trunc timezone footgun from Stage H's weekly missions).
-- =============================================================
CREATE OR REPLACE FUNCTION get_current_period_value(p_period_type TEXT)
RETURNS VARCHAR AS $$
  SELECT CASE p_period_type
    WHEN 'weekly'  THEN TO_CHAR(date_trunc('week', CURRENT_DATE), 'IYYY-"W"IW')
    WHEN 'monthly' THEN TO_CHAR(CURRENT_DATE, 'YYYY-MM')
    ELSE 'all-time'
  END;
$$ LANGUAGE SQL STABLE;
