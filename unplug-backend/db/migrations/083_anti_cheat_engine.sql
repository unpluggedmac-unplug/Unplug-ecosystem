-- Participation Engine — Stage O: Anti-Cheat Engine.
--
-- trust_scores and the min_trust_score gate inside award_points() have
-- existed since Stage A, but nothing has ever written to trust_scores or
-- set a non-zero min_trust_score on any action — so the whole mechanism
-- has been dead weight this entire time, same gap Stage K found and
-- fixed for streaks. This stage: (1) writes real detection logic for two
-- patterns this schema can actually observe, (2) gives the gate
-- something to actually enforce by setting min_trust_score on the two
-- actions most exposed to farming, and (3) an admin panel to review and
-- reverse flags, since an automated system WILL produce false positives
-- and needs a human escape hatch — same reasoning as Business Hall of
-- Fame being admin-granted only.
--
-- Two detectable patterns, both graduated (a deduction, not a ban) and
-- both logged to moderation_actions (Stage A) with admin_user_id = NULL
-- to distinguish an automatic flag from an admin-initiated one:
--
--  1. VELOCITY — an abnormal number of point-earning actions in a short
--     window. A real member simply cannot recognise, vote, and post at
--     that rate; a script can. Checked generically inside award_points()
--     so it applies to every action, not just one.
--
--  2. RECIPROCAL RECOGNITION — two accounts recognising each other back
--     and forth to farm both recognition_give and recognition_receive
--     points. Existing limits (5/day, 20/week on giving, one type per
--     pair) don't stop a slow steady back-and-forth over weeks — this
--     looks at the pair's total exchange over a rolling window instead
--     of a single member's own limits.

-- =============================================================
-- 1. TRUST FLAGGING — shared helper. Deducts points from trust_scores
-- (floor 0, matching the table's own CHECK constraint), increments the
-- flag counter, and logs the reason. Idempotent to call repeatedly —
-- each call is one more flag, same as it would be for a human reviewer
-- clicking "flag" more than once.
-- =============================================================
CREATE OR REPLACE FUNCTION flag_trust(p_user_id INTEGER, p_points INTEGER, p_reason TEXT, p_action_type TEXT)
RETURNS VOID AS $$
BEGIN
  INSERT INTO trust_scores (user_id, score, flags, last_flag_at)
  VALUES (p_user_id, GREATEST(100 - p_points, 0), 1, now())
  ON CONFLICT (user_id) DO UPDATE SET
    score = GREATEST(trust_scores.score - p_points, 0),
    flags = trust_scores.flags + 1,
    last_flag_at = now(),
    updated_at = now();

  INSERT INTO moderation_actions (target_user_id, admin_user_id, action_type, reason, points_affected)
  VALUES (p_user_id, NULL, p_action_type, p_reason, -p_points);
END;
$$ LANGUAGE plpgsql;

-- =============================================================
-- 2. VELOCITY CHECK — more than 20 point-earning actions (any action) in
-- a 5-minute window. Called from inside award_points() itself, after the
-- ledger row is written, so it's checking real history, not guessing.
-- -15 trust per flag; deliberately smaller than the reciprocal penalty
-- since a single velocity spike is weaker evidence than a sustained
-- reciprocal pattern (a legitimate burst — e.g. catching up on a backlog
-- of recognitions — can trip this once without much consequence).
-- =============================================================
CREATE OR REPLACE FUNCTION check_velocity_abuse(p_user_id INTEGER)
RETURNS BOOLEAN AS $$
DECLARE
  v_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_count FROM participation_points
   WHERE user_id = p_user_id AND is_reversed = FALSE AND earned_at >= now() - INTERVAL '5 minutes';

  IF v_count > 20 THEN
    PERFORM flag_trust(p_user_id, 15, v_count || ' point-earning actions in 5 minutes', 'auto_flag_velocity');
    RETURN TRUE;
  END IF;
  RETURN FALSE;
END;
$$ LANGUAGE plpgsql;

-- =============================================================
-- 3. RECIPROCAL RECOGNITION CHECK — a pair exchanging 8+ recognitions
-- (combined both directions) within a rolling 7 days. Flags BOTH
-- accounts, since a farming pair is farming together. -25 trust each —
-- larger than velocity because a sustained reciprocal pattern is much
-- harder to produce by accident than a single fast burst.
-- =============================================================
CREATE OR REPLACE FUNCTION check_reciprocal_recognition_abuse(p_user_a INTEGER, p_user_b INTEGER)
RETURNS BOOLEAN AS $$
DECLARE
  v_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_count FROM recognitions
   WHERE is_reversed = FALSE AND created_at >= now() - INTERVAL '7 days'
     AND ((from_user_id = p_user_a AND to_user_id = p_user_b) OR (from_user_id = p_user_b AND to_user_id = p_user_a));

  IF v_count >= 8 THEN
    PERFORM flag_trust(p_user_a, 25, v_count || ' reciprocal recognitions with user ' || p_user_b || ' in 7 days', 'auto_flag_reciprocal');
    PERFORM flag_trust(p_user_b, 25, v_count || ' reciprocal recognitions with user ' || p_user_a || ' in 7 days', 'auto_flag_reciprocal');
    RETURN TRUE;
  END IF;
  RETURN FALSE;
END;
$$ LANGUAGE plpgsql;

-- =============================================================
-- 4. AWARD_POINTS — re-declared in full (same CREATE OR REPLACE
-- requirement as Stage K) with one addition: a velocity check right
-- after the ledger write succeeds. Everything else is byte-for-byte
-- identical to Stage K's award_points() in 080_streak_tiers.sql.
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
    PERFORM check_and_award_streak_tier(p_user_id);
  END IF;

  PERFORM check_velocity_abuse(p_user_id);

  PERFORM recalculate_score_cache(p_user_id);
  PERFORM check_and_update_status(p_user_id);

  RETURN QUERY SELECT TRUE, v_tx_id, v_total_points, NULL::TEXT;
END;
$$ LANGUAGE plpgsql;

-- =============================================================
-- 5. PROCESS_RECOGNITION — re-declared with one addition: the reciprocal
-- check after both award_points() calls succeed. Everything else is
-- byte-for-byte identical to Stage C's process_recognition() in
-- 074_recognition_achievements_missions.sql.
-- =============================================================
CREATE OR REPLACE FUNCTION process_recognition(
  p_from_user_id     INTEGER,
  p_to_user_id       INTEGER,
  p_recognition_type TEXT,
  p_message          TEXT    DEFAULT NULL,
  p_is_public        BOOLEAN DEFAULT TRUE
)
RETURNS TABLE (success BOOLEAN, recognition_id INTEGER, blocked_reason TEXT) AS $$
DECLARE
  v_rec_type recognition_types%ROWTYPE;
  v_rec_id   INTEGER;
BEGIN
  SELECT * INTO v_rec_type FROM recognition_types WHERE code = p_recognition_type AND is_enabled = TRUE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, NULL::INTEGER, 'invalid_recognition_type';
    RETURN;
  END IF;

  IF p_from_user_id = p_to_user_id THEN
    RETURN QUERY SELECT FALSE, NULL::INTEGER, 'self_recognition_not_allowed';
    RETURN;
  END IF;

  BEGIN
    INSERT INTO recognitions (from_user_id, to_user_id, recognition_type, message, is_public)
    VALUES (p_from_user_id, p_to_user_id, p_recognition_type, p_message, p_is_public)
    RETURNING id INTO v_rec_id;
  EXCEPTION WHEN unique_violation THEN
    RETURN QUERY SELECT FALSE, NULL::INTEGER, 'already_recognised_this_type';
    RETURN;
  END;

  PERFORM award_points(p_user_id := p_from_user_id, p_action_code := 'recognition_give',
    p_content_type := 'profile', p_content_id := p_to_user_id, p_source := 'system',
    p_notes := 'Recognised ' || p_recognition_type);

  PERFORM award_points(p_user_id := p_to_user_id, p_action_code := 'recognition_receive',
    p_content_type := 'profile', p_content_id := p_from_user_id, p_source := 'system',
    p_notes := 'Received recognition: ' || p_recognition_type);

  INSERT INTO recognition_counts (user_id, total_received) VALUES (p_to_user_id, 1)
  ON CONFLICT (user_id) DO UPDATE SET total_received = recognition_counts.total_received + 1, updated_at = now();

  EXECUTE format('UPDATE recognition_counts SET %I = %I + 1, updated_at = now() WHERE user_id = $1',
    p_recognition_type || '_count', p_recognition_type || '_count') USING p_to_user_id;

  INSERT INTO recognition_counts (user_id, total_given) VALUES (p_from_user_id, 1)
  ON CONFLICT (user_id) DO UPDATE SET total_given = recognition_counts.total_given + 1, updated_at = now();

  INSERT INTO notifications (user_id, type, title, body, link_url)
  VALUES (p_to_user_id, 'recognition', v_rec_type.emoji || ' You have been recognised!',
    'Someone recognised you as ' || v_rec_type.label || '.' ||
    CASE WHEN p_message IS NOT NULL THEN ' "' || LEFT(p_message, 100) || '"' ELSE '' END,
    '/unplug-member-dashboard.html');

  PERFORM sync_achievements(p_to_user_id);
  PERFORM sync_achievements(p_from_user_id);

  PERFORM check_reciprocal_recognition_abuse(p_from_user_id, p_to_user_id);

  RETURN QUERY SELECT TRUE, v_rec_id, NULL::TEXT;
END;
$$ LANGUAGE plpgsql;

-- =============================================================
-- 6. Give the gate something to actually enforce. Both defaulted to 0
-- (no floor) since Stage A — the two actions most exposed to farming
-- (give/receive recognition, and voting) now require a trust score of at
-- least 50, which only someone with 2+ real flags could ever fall below.
-- Nothing else is touched — most actions stay ungated.
-- =============================================================
UPDATE participation_actions SET min_trust_score = 50 WHERE code IN ('recognition_give', 'recognition_receive', 'top10_vote');
