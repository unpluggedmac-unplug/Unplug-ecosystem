-- Participation Engine — Stage A: core scoring functions.
-- Ported from the Supabase-native spec onto plain Postgres functions —
-- nothing here is Supabase-specific (no auth.uid(), no RLS), so the
-- logic transplants directly. Called from Express route handlers via
-- pool.query('SELECT * FROM award_points($1, $2, ...)'), not from a
-- Supabase client. "Join date" uses users.created_at — this project's
-- Directory `profiles` table is a separate concept (a service listing,
-- not identity) and is intentionally not touched by any of this.
--
-- CREATE OR REPLACE is safe to re-run on every deploy, same as every
-- other function in this codebase.

-- =============================================================
-- HELPERS
-- =============================================================
CREATE OR REPLACE FUNCTION get_trust_score(p_user_id INTEGER)
RETURNS NUMERIC AS $$
  SELECT COALESCE(score, 100.00) FROM trust_scores WHERE user_id = p_user_id;
$$ LANGUAGE SQL STABLE;

CREATE OR REPLACE FUNCTION get_user_status_rank(p_user_id INTEGER)
RETURNS INTEGER AS $$
  SELECT COALESCE(
    (SELECT sl.rank_order
       FROM member_status_history msh
       JOIN member_status_levels sl ON sl.code = msh.status_code
      WHERE msh.user_id = p_user_id AND msh.is_active_status = TRUE
      LIMIT 1),
    0
  );
$$ LANGUAGE SQL STABLE;

CREATE OR REPLACE FUNCTION get_active_months_count(p_user_id INTEGER)
RETURNS INTEGER AS $$
  SELECT COUNT(*)::INTEGER FROM active_months WHERE user_id = p_user_id AND is_qualified = TRUE;
$$ LANGUAGE SQL STABLE;

CREATE OR REPLACE FUNCTION get_days_since_join(p_user_id INTEGER)
RETURNS INTEGER AS $$
  SELECT EXTRACT(DAY FROM now() - created_at)::INTEGER FROM users WHERE id = p_user_id;
$$ LANGUAGE SQL STABLE;

-- =============================================================
-- CORE: AWARD POINTS
-- The single entry point for every point transaction. Enforces every
-- rule-engine constraint (trust floor, status floor, per-object
-- uniqueness, daily/weekly/monthly limits) before writing to the ledger.
-- =============================================================
CREATE OR REPLACE FUNCTION award_points(
  p_user_id            INTEGER,
  p_action_code        VARCHAR,
  p_content_type       VARCHAR    DEFAULT NULL,
  p_content_id         INTEGER    DEFAULT NULL,
  p_content_owner      INTEGER    DEFAULT NULL,
  p_base_override      INTEGER    DEFAULT NULL,
  p_quality_bonus      INTEGER    DEFAULT 0,
  p_impact_bonus       INTEGER    DEFAULT 0,
  p_consistency_bonus  INTEGER    DEFAULT 0,
  p_source             VARCHAR    DEFAULT 'system',
  p_granted_by         INTEGER    DEFAULT NULL,
  p_notes              TEXT       DEFAULT NULL
)
RETURNS TABLE (
  success        BOOLEAN,
  tx_id          INTEGER,
  points_earned  INTEGER,
  blocked_reason TEXT
) AS $$
DECLARE
  v_action        participation_actions%ROWTYPE;
  v_trust         NUMERIC;
  v_status_rank   INTEGER;
  v_daily_count   INTEGER;
  v_weekly_count  INTEGER;
  v_monthly_count INTEGER;
  v_object_exists BOOLEAN;
  v_base_points   INTEGER;
  v_total_points  INTEGER;
  v_tx_id         INTEGER;
  v_today         DATE := CURRENT_DATE;
  v_year          INTEGER := EXTRACT(YEAR FROM now())::INTEGER;
  v_week          INTEGER := EXTRACT(WEEK FROM now())::INTEGER;
  v_month         INTEGER := EXTRACT(MONTH FROM now())::INTEGER;
BEGIN
  SELECT * INTO v_action FROM participation_actions WHERE code = p_action_code AND is_enabled = TRUE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, NULL::INTEGER, 0, 'action_not_found_or_disabled';
    RETURN;
  END IF;

  v_trust := get_trust_score(p_user_id);
  IF v_trust < v_action.min_trust_score THEN
    RETURN QUERY SELECT FALSE, NULL::INTEGER, 0, 'trust_score_insufficient';
    RETURN;
  END IF;

  v_status_rank := get_user_status_rank(p_user_id);
  IF v_status_rank < v_action.min_status_rank THEN
    RETURN QUERY SELECT FALSE, NULL::INTEGER, 0, 'status_insufficient';
    RETURN;
  END IF;

  IF v_action.unique_per_object AND p_content_id IS NOT NULL THEN
    SELECT EXISTS(
      SELECT 1 FROM object_action_tracker
       WHERE user_id = p_user_id AND action_code = p_action_code
         AND content_type = p_content_type AND content_id = p_content_id
         AND is_reversed = FALSE
    ) INTO v_object_exists;
    IF v_object_exists THEN
      RETURN QUERY SELECT FALSE, NULL::INTEGER, 0, 'already_earned_for_object';
      RETURN;
    END IF;
  END IF;

  IF v_action.daily_limit IS NOT NULL THEN
    SELECT COALESCE(count, 0) INTO v_daily_count FROM daily_action_tracker
     WHERE user_id = p_user_id AND action_code = p_action_code AND action_date = v_today;
    IF v_daily_count >= v_action.daily_limit THEN
      RETURN QUERY SELECT FALSE, NULL::INTEGER, 0, 'daily_limit_reached';
      RETURN;
    END IF;
  END IF;

  IF v_action.weekly_limit IS NOT NULL THEN
    SELECT COALESCE(count, 0) INTO v_weekly_count FROM weekly_action_tracker
     WHERE user_id = p_user_id AND action_code = p_action_code AND iso_year = v_year AND iso_week = v_week;
    IF v_weekly_count >= v_action.weekly_limit THEN
      RETURN QUERY SELECT FALSE, NULL::INTEGER, 0, 'weekly_limit_reached';
      RETURN;
    END IF;
  END IF;

  IF v_action.monthly_limit IS NOT NULL THEN
    SELECT COALESCE(count, 0) INTO v_monthly_count FROM monthly_action_tracker
     WHERE user_id = p_user_id AND action_code = p_action_code AND year = v_year AND month = v_month;
    IF v_monthly_count >= v_action.monthly_limit THEN
      RETURN QUERY SELECT FALSE, NULL::INTEGER, 0, 'monthly_limit_reached';
      RETURN;
    END IF;
  END IF;

  v_base_points  := COALESCE(p_base_override, v_action.base_points);
  v_total_points := v_base_points + p_quality_bonus + p_impact_bonus + p_consistency_bonus;

  INSERT INTO participation_points (
    user_id, action_code, content_type, content_id, content_owner_id,
    base_points, quality_bonus, impact_bonus, consistency_bonus, total_points,
    source, granted_by, notes
  ) VALUES (
    p_user_id, p_action_code, p_content_type, p_content_id, p_content_owner,
    v_base_points, p_quality_bonus, p_impact_bonus, p_consistency_bonus, v_total_points,
    p_source, p_granted_by, p_notes
  ) RETURNING id INTO v_tx_id;

  INSERT INTO daily_action_tracker (user_id, action_code, action_date, count, last_at)
  VALUES (p_user_id, p_action_code, v_today, 1, now())
  ON CONFLICT (user_id, action_code, action_date)
  DO UPDATE SET count = daily_action_tracker.count + 1, last_at = now();

  INSERT INTO weekly_action_tracker (user_id, action_code, iso_year, iso_week, count, last_at)
  VALUES (p_user_id, p_action_code, v_year, v_week, 1, now())
  ON CONFLICT (user_id, action_code, iso_year, iso_week)
  DO UPDATE SET count = weekly_action_tracker.count + 1, last_at = now();

  INSERT INTO monthly_action_tracker (user_id, action_code, year, month, count, last_at)
  VALUES (p_user_id, p_action_code, v_year, v_month, 1, now())
  ON CONFLICT (user_id, action_code, year, month)
  DO UPDATE SET count = monthly_action_tracker.count + 1, last_at = now();

  IF v_action.unique_per_object AND p_content_id IS NOT NULL THEN
    INSERT INTO object_action_tracker (user_id, action_code, content_type, content_id)
    VALUES (p_user_id, p_action_code, p_content_type, p_content_id)
    ON CONFLICT DO NOTHING;
  END IF;

  IF v_action.counts_for_active_month OR v_action.counts_as_meaningful OR v_action.counts_as_contribution THEN
    INSERT INTO active_months (user_id, year, month, active_days, meaningful_actions, qualifying_contributions)
    VALUES (p_user_id, v_year, v_month, 1, 0, 0)
    ON CONFLICT (user_id, year, month) DO UPDATE SET
      active_days = (
        SELECT COUNT(DISTINCT DATE(pp.earned_at)) FROM participation_points pp
        JOIN participation_actions pa ON pa.code = pp.action_code
        WHERE pp.user_id = p_user_id AND EXTRACT(YEAR FROM pp.earned_at) = v_year
          AND EXTRACT(MONTH FROM pp.earned_at) = v_month AND pp.is_reversed = FALSE
          AND pa.counts_for_active_month = TRUE
      ),
      meaningful_actions = (
        SELECT COUNT(*) FROM participation_points pp
        JOIN participation_actions pa ON pa.code = pp.action_code
        WHERE pp.user_id = p_user_id AND EXTRACT(YEAR FROM pp.earned_at) = v_year
          AND EXTRACT(MONTH FROM pp.earned_at) = v_month AND pp.is_reversed = FALSE
          AND pa.counts_as_meaningful = TRUE
      ),
      qualifying_contributions = (
        SELECT COUNT(*) FROM participation_points pp
        JOIN participation_actions pa ON pa.code = pp.action_code
        WHERE pp.user_id = p_user_id AND EXTRACT(YEAR FROM pp.earned_at) = v_year
          AND EXTRACT(MONTH FROM pp.earned_at) = v_month AND pp.is_reversed = FALSE
          AND pa.counts_as_contribution = TRUE
      ),
      updated_at = now();
  END IF;

  IF v_action.counts_for_streak THEN
    PERFORM update_streak(p_user_id, v_today);
  END IF;

  PERFORM recalculate_score_cache(p_user_id);
  PERFORM check_and_update_status(p_user_id);

  RETURN QUERY SELECT TRUE, v_tx_id, v_total_points, NULL::TEXT;
END;
$$ LANGUAGE plpgsql;

-- =============================================================
-- CORE: RECALCULATE SCORE CACHE
-- =============================================================
CREATE OR REPLACE FUNCTION recalculate_score_cache(p_user_id INTEGER)
RETURNS VOID AS $$
DECLARE
  v_participation  INTEGER;
  v_contribution   INTEGER;
  v_impact         INTEGER;
  v_recognition    INTEGER;
  v_quality        INTEGER;
  v_consistency    INTEGER;
  v_momentum       INTEGER;
  v_total          INTEGER;
  v_total_actions  INTEGER;
  v_days_join      INTEGER;
  v_active_months  INTEGER;
BEGIN
  SELECT
    COALESCE(SUM(CASE WHEN pa.category_code = 'consumption' THEN pp.total_points ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN pa.category_code = 'contribution' THEN pp.total_points ELSE 0 END), 0),
    COALESCE(SUM(pp.impact_bonus), 0),
    COALESCE(SUM(CASE WHEN pa.category_code = 'community' THEN pp.total_points ELSE 0 END), 0),
    COALESCE(SUM(pp.quality_bonus), 0),
    COALESCE(SUM(pp.consistency_bonus), 0),
    COUNT(*)::INTEGER
  INTO v_participation, v_contribution, v_impact, v_recognition, v_quality, v_consistency, v_total_actions
  FROM participation_points pp
  JOIN participation_actions pa ON pa.code = pp.action_code
  WHERE pp.user_id = p_user_id AND pp.is_reversed = FALSE;

  SELECT COALESCE(SUM(pp.total_points), 0) INTO v_momentum
  FROM participation_points pp
  WHERE pp.user_id = p_user_id AND pp.is_reversed = FALSE AND pp.earned_at >= now() - INTERVAL '30 days';

  -- The total is the straight sum of every earned point, not the sum of
  -- the category buckets above — those only cover 3 of the 6 action
  -- categories (consumption/contribution/community) and are informational
  -- breakdowns, not an exhaustive partition. Deriving the total from them
  -- would silently drop points from social/competitive/achievement-category
  -- actions (including admin manual grants) out of the member's score.
  SELECT COALESCE(SUM(pp.total_points), 0) INTO v_total
  FROM participation_points pp
  WHERE pp.user_id = p_user_id AND pp.is_reversed = FALSE;
  v_days_join := get_days_since_join(p_user_id);
  v_active_months := get_active_months_count(p_user_id);

  INSERT INTO score_cache (
    user_id, unplug_score, participation_score, contribution_score, impact_score,
    recognition_score, quality_score, consistency_score, momentum_score,
    total_actions, qualified_active_months, days_since_join, last_recalculated_at
  ) VALUES (
    p_user_id, v_total, v_participation, v_contribution, v_impact,
    v_recognition, v_quality, v_consistency, v_momentum,
    v_total_actions, v_active_months, v_days_join, now()
  )
  ON CONFLICT (user_id) DO UPDATE SET
    unplug_score            = EXCLUDED.unplug_score,
    participation_score     = EXCLUDED.participation_score,
    contribution_score      = EXCLUDED.contribution_score,
    impact_score             = EXCLUDED.impact_score,
    recognition_score       = EXCLUDED.recognition_score,
    quality_score            = EXCLUDED.quality_score,
    consistency_score       = EXCLUDED.consistency_score,
    momentum_score           = EXCLUDED.momentum_score,
    total_actions            = EXCLUDED.total_actions,
    qualified_active_months = EXCLUDED.qualified_active_months,
    days_since_join          = EXCLUDED.days_since_join,
    last_recalculated_at     = now();

  PERFORM qualify_active_months(p_user_id);
END;
$$ LANGUAGE plpgsql;

-- =============================================================
-- CORE: QUALIFY ACTIVE MONTHS
-- Thresholds are hardcoded defaults (3 active days, 5 meaningful
-- actions, 1 qualifying contribution) — same as the source spec.
-- =============================================================
CREATE OR REPLACE FUNCTION qualify_active_months(p_user_id INTEGER)
RETURNS VOID AS $$
  UPDATE active_months
     SET is_qualified = (active_days >= 3 AND meaningful_actions >= 5 AND qualifying_contributions >= 1),
         qualified_at = CASE
           WHEN active_days >= 3 AND meaningful_actions >= 5 AND qualifying_contributions >= 1
           THEN COALESCE(qualified_at, now()) ELSE NULL END,
         updated_at = now()
   WHERE user_id = p_user_id;
$$ LANGUAGE SQL;

-- =============================================================
-- CORE: UPDATE STREAK
-- =============================================================
CREATE OR REPLACE FUNCTION update_streak(p_user_id INTEGER, p_today DATE)
RETURNS VOID AS $$
DECLARE
  v_last_action     DATE;
  v_current_streak  INTEGER;
  v_longest_streak  INTEGER;
BEGIN
  SELECT last_streak_action, current_streak_days, longest_streak_days
    INTO v_last_action, v_current_streak, v_longest_streak
    FROM user_streaks WHERE user_id = p_user_id;

  IF NOT FOUND THEN
    INSERT INTO user_streaks (user_id, current_streak_days, longest_streak_days, streak_started_at, last_streak_action)
    VALUES (p_user_id, 1, 1, p_today, p_today);
    RETURN;
  END IF;

  IF v_last_action = p_today THEN
    RETURN;
  ELSIF v_last_action = p_today - INTERVAL '1 day' THEN
    v_current_streak := v_current_streak + 1;
    v_longest_streak := GREATEST(v_longest_streak, v_current_streak);
    UPDATE user_streaks SET
      current_streak_days = v_current_streak, longest_streak_days = v_longest_streak,
      last_streak_action = p_today, updated_at = now()
    WHERE user_id = p_user_id;
  ELSE
    UPDATE user_streaks SET
      current_streak_days = 1, streak_started_at = p_today,
      last_streak_action = p_today, streak_broken_at = v_last_action, updated_at = now()
    WHERE user_id = p_user_id;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- =============================================================
-- CORE: CHECK AND UPDATE MEMBER STATUS
-- =============================================================
CREATE OR REPLACE FUNCTION check_and_update_status(p_user_id INTEGER)
RETURNS TEXT AS $$
DECLARE
  v_score         INTEGER;
  v_days_join     INTEGER;
  v_active_months INTEGER;
  v_current_rank  INTEGER;
  v_new_status    member_status_levels%ROWTYPE;
BEGIN
  SELECT unplug_score, days_since_join, qualified_active_months
    INTO v_score, v_days_join, v_active_months
    FROM score_cache WHERE user_id = p_user_id;

  IF NOT FOUND THEN RETURN 'no_score_cache'; END IF;

  v_current_rank := get_user_status_rank(p_user_id);

  SELECT * INTO v_new_status FROM member_status_levels
   WHERE is_member_hall_of_fame = FALSE AND requires_admin_approval = FALSE
     AND rank_order > v_current_rank
     AND min_score <= v_score AND min_days_since_join <= v_days_join AND min_active_months <= v_active_months
   ORDER BY rank_order DESC LIMIT 1;

  IF NOT FOUND THEN RETURN 'no_new_status'; END IF;

  UPDATE member_status_history SET is_active_status = FALSE WHERE user_id = p_user_id AND is_active_status = TRUE;

  INSERT INTO member_status_history (
    user_id, status_code, previous_status, score_at_time, active_months_at_time, days_since_join_at_time, is_active_status
  ) VALUES (
    p_user_id, v_new_status.code,
    (SELECT status_code FROM member_status_history WHERE user_id = p_user_id ORDER BY achieved_at DESC LIMIT 1),
    v_score, v_active_months, v_days_join, TRUE
  );

  INSERT INTO notifications (user_id, type, title, body, link_url)
  VALUES (
    p_user_id, 'status_change',
    'You reached ' || v_new_status.emoji || ' ' || v_new_status.label || '!',
    'Your participation has levelled up. View your new status on your dashboard.',
    '/unplug-member-dashboard.html'
  );

  RETURN 'promoted_to_' || v_new_status.code;
END;
$$ LANGUAGE plpgsql;

-- =============================================================
-- CORE: REVERSE POINTS (admin-initiated correction)
-- =============================================================
CREATE OR REPLACE FUNCTION reverse_points(p_tx_id INTEGER, p_admin_id INTEGER, p_reason TEXT)
RETURNS BOOLEAN AS $$
DECLARE
  v_tx participation_points%ROWTYPE;
BEGIN
  SELECT * INTO v_tx FROM participation_points WHERE id = p_tx_id;
  IF NOT FOUND OR v_tx.is_reversed THEN RETURN FALSE; END IF;

  UPDATE participation_points SET
    is_reversed = TRUE, reversed_at = now(), reversed_by = p_admin_id, reversal_reason = p_reason
  WHERE id = p_tx_id;

  UPDATE object_action_tracker SET is_reversed = TRUE
   WHERE user_id = v_tx.user_id AND action_code = v_tx.action_code
     AND content_type = v_tx.content_type AND content_id = v_tx.content_id;

  INSERT INTO moderation_actions (target_user_id, admin_user_id, action_type, reason, related_content_type, related_content_id, points_affected)
  VALUES (v_tx.user_id, p_admin_id, 'reverse_points', p_reason, v_tx.content_type, v_tx.content_id, -v_tx.total_points);

  PERFORM recalculate_score_cache(v_tx.user_id);
  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

-- =============================================================
-- ADMIN: MANUAL POINT GRANT
-- =============================================================
CREATE OR REPLACE FUNCTION admin_award_points(p_user_id INTEGER, p_admin_id INTEGER, p_points INTEGER, p_reason TEXT)
RETURNS TABLE (success BOOLEAN, tx_id INTEGER) AS $$
DECLARE
  v_tx INTEGER;
BEGIN
  -- ap.tx_id is qualified (not bare "tx_id") because this function's own
  -- RETURNS TABLE also declares an output column named tx_id, which
  -- Postgres treats as an implicit variable in scope here — a bare
  -- reference is ambiguous between that and award_points()'s result column.
  SELECT ap.tx_id INTO v_tx FROM award_points(
    p_user_id       := p_user_id,
    p_action_code   := 'admin_grant',
    p_base_override := p_points,
    p_source        := 'admin',
    p_granted_by    := p_admin_id,
    p_notes         := 'Manual admin grant: ' || p_reason
  ) AS ap;

  INSERT INTO moderation_actions (target_user_id, admin_user_id, action_type, reason, points_affected)
  VALUES (p_user_id, p_admin_id, 'award_points', p_reason, p_points);

  RETURN QUERY SELECT v_tx IS NOT NULL, v_tx;
END;
$$ LANGUAGE plpgsql;

-- A generic action row so admin_award_points() above always has something
-- valid to reference (base_points is irrelevant — always overridden).
INSERT INTO participation_actions (code, label, category_code, base_points, unique_per_object, is_enabled, notes)
VALUES ('admin_grant', 'Manual admin point grant', 'achievement', 0, FALSE, TRUE, 'System action code used only by admin_award_points().')
ON CONFLICT (code) DO NOTHING;
