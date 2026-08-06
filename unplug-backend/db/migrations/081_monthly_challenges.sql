-- Participation Engine — Stage L: Monthly Challenges.
--
-- The `missions` table has allowed mission_type = 'challenge' since Stage
-- C (CHECK constraint already includes it), but nothing has ever rotated,
-- assigned, or tracked one — exactly the same gap Stage H filled for
-- weekly missions. This is that same rotation mechanism at monthly
-- cadence: one active challenge at a time, auto-rotating (least-recently-
-- used) from the pool of enabled challenge missions.

-- =============================================================
-- 1. MONTHLY ROTATION HISTORY — mirrors weekly_mission_rotation exactly,
-- one row per calendar month that's had an active challenge.
-- =============================================================
CREATE TABLE IF NOT EXISTS monthly_challenge_rotation (
  id           SERIAL PRIMARY KEY,
  mission_code VARCHAR(60) NOT NULL REFERENCES missions(code),
  month_start  DATE NOT NULL UNIQUE,
  month_end    DATE NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_monthly_rotation_month ON monthly_challenge_rotation(month_start DESC);

-- =============================================================
-- 2. ROTATE — same least-recently-used pool cycling as
-- rotate_weekly_mission(), at month_start = date_trunc('month', ...)
-- granularity instead of week.
-- =============================================================
CREATE OR REPLACE FUNCTION rotate_monthly_challenge()
RETURNS VARCHAR AS $$
DECLARE
  v_month_start DATE := date_trunc('month', CURRENT_DATE)::DATE;
  v_month_end   DATE := (date_trunc('month', CURRENT_DATE) + INTERVAL '1 month' - INTERVAL '1 day')::DATE;
  v_pool_size   INTEGER;
  v_chosen      VARCHAR(60);
BEGIN
  IF EXISTS (SELECT 1 FROM monthly_challenge_rotation WHERE month_start = v_month_start) THEN
    RETURN (SELECT mission_code FROM monthly_challenge_rotation WHERE month_start = v_month_start);
  END IF;

  SELECT COUNT(*) INTO v_pool_size FROM missions WHERE mission_type = 'challenge' AND is_enabled = TRUE;
  IF v_pool_size = 0 THEN
    RETURN NULL;
  END IF;

  SELECT m.code INTO v_chosen
    FROM missions m
   WHERE m.mission_type = 'challenge' AND m.is_enabled = TRUE
     AND m.code NOT IN (
       SELECT mission_code FROM monthly_challenge_rotation
        ORDER BY month_start DESC
        LIMIT GREATEST(v_pool_size - 1, 0)
     )
   ORDER BY RANDOM()
   LIMIT 1;

  INSERT INTO monthly_challenge_rotation (mission_code, month_start, month_end)
  VALUES (v_chosen, v_month_start, v_month_end);

  RETURN v_chosen;
END;
$$ LANGUAGE plpgsql;

-- =============================================================
-- 3. THIS MONTH'S CHALLENGE — auto-rotates on first read.
-- =============================================================
CREATE OR REPLACE FUNCTION get_current_monthly_challenge()
RETURNS TABLE (
  code           VARCHAR,
  title          VARCHAR,
  description    TEXT,
  points_reward  INTEGER,
  target_count   INTEGER,
  action_code    VARCHAR,
  month_start    DATE,
  month_end      DATE
) AS $$
DECLARE
  v_month_start DATE := date_trunc('month', CURRENT_DATE)::DATE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM monthly_challenge_rotation WHERE monthly_challenge_rotation.month_start = v_month_start) THEN
    PERFORM rotate_monthly_challenge();
  END IF;

  RETURN QUERY
  SELECT m.code, m.title, m.description, m.points_reward, m.target_count, m.action_code,
         mr.month_start, mr.month_end
    FROM monthly_challenge_rotation mr
    JOIN missions m ON m.code = mr.mission_code
   WHERE mr.month_start = v_month_start;
END;
$$ LANGUAGE plpgsql;

-- =============================================================
-- 4. ASSIGN this month's challenge to a member (idempotent).
-- =============================================================
CREATE OR REPLACE FUNCTION assign_monthly_challenge(p_user_id INTEGER)
RETURNS VOID AS $$
DECLARE
  v_current RECORD;
BEGIN
  SELECT * INTO v_current FROM get_current_monthly_challenge();
  IF v_current.code IS NULL THEN RETURN; END IF;

  INSERT INTO user_missions (user_id, mission_code, assigned_date, progress_count, is_completed)
  VALUES (p_user_id, v_current.code, v_current.month_start, 0, FALSE)
  ON CONFLICT DO NOTHING;
END;
$$ LANGUAGE plpgsql;

-- =============================================================
-- 5. UPDATE_MISSION_PROGRESS — extended a third time (Stage C: daily,
-- Stage H: weekly, now: challenge/monthly). Same CREATE OR REPLACE
-- pattern — signature unchanged, body grows a third matching clause.
-- =============================================================
CREATE OR REPLACE FUNCTION update_mission_progress(p_user_id INTEGER, p_action_code TEXT)
RETURNS INTEGER AS $$
DECLARE
  v_today       DATE := CURRENT_DATE;
  v_week_start  DATE := date_trunc('week', CURRENT_DATE)::DATE;
  v_month_start DATE := date_trunc('month', CURRENT_DATE)::DATE;
  v_mission     user_missions%ROWTYPE;
  v_def         missions%ROWTYPE;
  v_completed   INTEGER := 0;
  v_tx          RECORD;
BEGIN
  FOR v_mission IN
    SELECT um.* FROM user_missions um
    JOIN missions m ON m.code = um.mission_code
    WHERE um.user_id = p_user_id
      AND um.is_completed = FALSE
      AND m.action_code = p_action_code
      AND (
        (m.mission_type = 'daily' AND um.assigned_date = v_today)
        OR (m.mission_type = 'weekly' AND um.assigned_date = v_week_start)
        OR (m.mission_type = 'challenge' AND um.assigned_date = v_month_start)
      )
  LOOP
    SELECT * INTO v_def FROM missions WHERE code = v_mission.mission_code;

    UPDATE user_missions SET progress_count = progress_count + 1
     WHERE id = v_mission.id RETURNING * INTO v_mission;

    IF v_mission.progress_count >= v_def.target_count THEN
      SELECT ap.tx_id INTO v_tx FROM award_points(
        p_user_id       := p_user_id,
        p_action_code   := 'mission_complete',
        p_base_override := v_def.points_reward,
        p_source        := 'system',
        p_notes         := 'Mission completed: ' || v_def.code
      ) AS ap;

      UPDATE user_missions SET is_completed = TRUE, completed_at = now(), points_tx_id = v_tx.tx_id
       WHERE id = v_mission.id;

      INSERT INTO notifications (user_id, type, title, body, link_url)
      VALUES (p_user_id, 'mission', '🎯 Mission complete: ' || v_def.title,
        'You earned ' || v_def.points_reward || ' points.', '/unplug-member-dashboard.html');

      v_completed := v_completed + 1;

      IF v_def.achievement_code IS NOT NULL THEN
        PERFORM sync_achievements(p_user_id);
      END IF;
    END IF;
  END LOOP;

  RETURN v_completed;
END;
$$ LANGUAGE plpgsql;

-- =============================================================
-- 6. SEED — 2 real challenge missions, same "only real, currently-
-- firable actions" rule as every prior stage. Bigger targets and higher
-- points than the weekly equivalents, matching the monthly cadence.
-- =============================================================
INSERT INTO missions (code, title, description, mission_type, action_code, points_reward, target_count) VALUES
  ('challenge_recognise20', 'Recognise 20 People', 'Give recognition to 20 different people this month.', 'challenge', 'recognition_give', 300, 20),
  ('challenge_vote40',      'Vote 40 Times',        'Cast 40 votes in the Top 10 this month.', 'challenge', 'top10_vote', 200, 40)
ON CONFLICT (code) DO NOTHING;
