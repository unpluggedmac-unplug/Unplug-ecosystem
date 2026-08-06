-- Participation Engine — Stage K: Streak tiers.
--
-- Streak tracking itself has existed since Stage A (user_streaks,
-- update_streak(), called automatically from award_points() whenever an
-- action has counts_for_streak = TRUE) — what's been missing is a reward
-- ladder: nothing happens when a member's streak crosses a milestone.
-- This adds that ladder as a normal admin-editable table, same pattern as
-- every other ladder in this engine (member/business status, missions).

-- =============================================================
-- 1. TIERS — 7 milestones, escalating bonus points. Ordered by min_days;
-- there's no separate rank_order column because min_days IS the rank —
-- two tiers can never tie or need reordering independent of their day
-- count.
-- =============================================================
CREATE TABLE IF NOT EXISTS streak_tiers (
  id            SERIAL PRIMARY KEY,
  code          VARCHAR(30) NOT NULL UNIQUE,
  label         VARCHAR(60) NOT NULL,
  emoji         VARCHAR(10) NOT NULL,
  min_days      INTEGER NOT NULL UNIQUE,
  bonus_points  INTEGER NOT NULL DEFAULT 0,
  description   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_streak_tiers_updated_at ON streak_tiers;
CREATE TRIGGER trg_streak_tiers_updated_at BEFORE UPDATE ON streak_tiers FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Tracks the highest tier already paid out for a member's CURRENT streak,
-- so crossing the same milestone twice in one streak (impossible, since
-- current_streak_days only grows) or re-running this check on an
-- unrelated award never double-pays. Reset to NULL whenever the streak
-- breaks (update_streak() resets current_streak_days to 1), so the next
-- streak starts earning tier bonuses again from the bottom.
ALTER TABLE user_streaks ADD COLUMN IF NOT EXISTS highest_tier_code VARCHAR(30) REFERENCES streak_tiers(code);

-- =============================================================
-- 1b. UPDATE_STREAK — re-declared with one addition: highest_tier_code is
-- cleared when the streak breaks (the ELSE branch below, where
-- current_streak_days resets to 1). Without this, a member who breaks a
-- streak keeps their old tier forever and can never re-earn a bonus on
-- their next streak, since check_and_award_streak_tier() only awards
-- tiers above whatever's already recorded. Otherwise identical to Stage
-- A's update_streak() in 072_participation_functions.sql.
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
      last_streak_action = p_today, streak_broken_at = v_last_action,
      highest_tier_code = NULL, updated_at = now()
    WHERE user_id = p_user_id;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- =============================================================
-- 2. CHECK AND AWARD — called from inside award_points() (below),
-- immediately after update_streak(). Awards at most one tier per call,
-- same "promote one rung at a time" pattern as the status ladders,
-- though in practice a streak can only ever grow by one day per call so
-- this never has more than one new tier to catch up on anyway.
-- =============================================================
CREATE OR REPLACE FUNCTION check_and_award_streak_tier(p_user_id INTEGER)
RETURNS TEXT AS $$
DECLARE
  v_current_days   INTEGER;
  v_highest_code   VARCHAR(30);
  v_highest_days   INTEGER;
  v_new_tier       streak_tiers%ROWTYPE;
  v_tx             RECORD;
BEGIN
  SELECT current_streak_days, highest_tier_code INTO v_current_days, v_highest_code
    FROM user_streaks WHERE user_id = p_user_id;
  IF NOT FOUND THEN RETURN 'no_streak'; END IF;

  SELECT min_days INTO v_highest_days FROM streak_tiers WHERE code = v_highest_code;
  v_highest_days := COALESCE(v_highest_days, 0);

  SELECT * INTO v_new_tier FROM streak_tiers
   WHERE min_days > v_highest_days AND min_days <= v_current_days
   ORDER BY min_days DESC LIMIT 1;

  IF NOT FOUND THEN RETURN 'no_new_tier'; END IF;

  UPDATE user_streaks SET highest_tier_code = v_new_tier.code WHERE user_id = p_user_id;

  IF v_new_tier.bonus_points > 0 THEN
    SELECT ap.tx_id INTO v_tx FROM award_points(
      p_user_id       := p_user_id,
      p_action_code   := 'streak_tier_bonus',
      p_base_override := v_new_tier.bonus_points,
      p_source        := 'system',
      p_notes         := 'Streak tier reached: ' || v_new_tier.code
    ) AS ap;
  END IF;

  INSERT INTO notifications (user_id, type, title, body, link_url)
  VALUES (
    p_user_id, 'streak_tier',
    v_new_tier.emoji || ' ' || v_new_tier.label || ' streak!',
    v_current_days || '-day streak' ||
      CASE WHEN v_new_tier.bonus_points > 0 THEN ' — +' || v_new_tier.bonus_points || ' bonus points.' ELSE '.' END,
    '/unplug-member-dashboard.html'
  );

  RETURN 'awarded_' || v_new_tier.code;
END;
$$ LANGUAGE plpgsql;

-- =============================================================
-- 3. AWARD_POINTS — re-declared in full (Postgres CREATE OR REPLACE
-- requires the whole body) with exactly one addition: a call to
-- check_and_award_streak_tier() right after update_streak(), guarded the
-- same way — only for actions with counts_for_streak = TRUE. The bonus
-- action itself ('streak_tier_bonus', seeded below) does NOT have
-- counts_for_streak set, so awarding it can never recurse back into this
-- block. Everything else below is byte-for-byte identical to Stage A's
-- award_points() in 072_participation_functions.sql.
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

  PERFORM recalculate_score_cache(p_user_id);
  PERFORM check_and_update_status(p_user_id);

  RETURN QUERY SELECT TRUE, v_tx_id, v_total_points, NULL::TEXT;
END;
$$ LANGUAGE plpgsql;

-- =============================================================
-- 4. SEED — 7 tiers, and the bonus-points action itself. Note
-- counts_for_streak is intentionally left at its default (FALSE) on
-- streak_tier_bonus — see the comment on award_points() above.
-- =============================================================
INSERT INTO streak_tiers (code, label, emoji, min_days, bonus_points, description) VALUES
  ('spark',      'Spark',      '✨', 3,   10, 'A 3-day streak.'),
  ('flame',      'Flame',      '🔥', 7,   25, 'A full week, back to back.'),
  ('blaze',      'Blaze',      '🔥', 14,  50, 'Two weeks of consistency.'),
  ('inferno',    'Inferno',    '🔥', 30, 100, 'A full month, every day.'),
  ('wildfire',   'Wildfire',   '🌋', 60, 200, 'Two months running.'),
  ('supernova',  'Supernova',  '💫', 100, 350, '100 days straight.'),
  ('legendary',  'Legendary',  '👑', 365, 1000, 'A full year, unbroken.')
ON CONFLICT (code) DO NOTHING;

INSERT INTO participation_actions (code, label, category_code, base_points, unique_per_object, counts_for_active_month, counts_as_meaningful, counts_as_contribution)
VALUES
  ('streak_tier_bonus', 'Streak milestone bonus', 'achievement', 0, FALSE, FALSE, FALSE, FALSE)
ON CONFLICT (code) DO NOTHING;

-- No production action has ever had counts_for_streak = TRUE (checked
-- before writing this migration — the flag existed since Stage A but
-- nothing set it), which would make every table and function above dead
-- weight nothing could ever trigger, the exact thing this project's build
-- history has repeatedly avoided. mission_complete (Stage C) is the
-- natural fit: daily missions reset every day specifically to pull
-- members back, so completing one is a genuine "showed up today" signal.
UPDATE participation_actions SET counts_for_streak = TRUE WHERE code = 'mission_complete';
