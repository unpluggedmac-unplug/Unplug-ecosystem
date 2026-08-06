-- Participation Engine — Stage H: Weekly Missions.
--
-- The `missions` table (Stage C) already supports mission_type='weekly' —
-- one weekly mission (weekly_invite) has been seeded since Stage C. What
-- was missing is the ROTATION mechanism: "only one Weekly Mission is
-- active at a time, and a different one rotates in automatically each
-- week." This migration adds that, plus admin CRUD for missions in
-- general (daily and weekly both use the same table).

-- =============================================================
-- 1. WEEKLY ROTATION HISTORY
-- One row per ISO week that has ever had an active weekly mission.
-- week_start is always a Monday (Postgres date_trunc('week', ...) is
-- ISO/Monday-based). This is both the rotation log AND what
-- get_current_weekly_mission() reads from.
-- =============================================================
CREATE TABLE IF NOT EXISTS weekly_mission_rotation (
  id           SERIAL PRIMARY KEY,
  mission_code VARCHAR(60) NOT NULL REFERENCES missions(code),
  week_start   DATE NOT NULL UNIQUE,
  week_end     DATE NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_weekly_rotation_week ON weekly_mission_rotation(week_start DESC);

-- =============================================================
-- 2. ROTATE — picks this week's mission if one hasn't been picked yet.
-- Idempotent: safe to call every scheduler tick, every deploy, however
-- often. Picks whichever enabled weekly mission was used LEAST recently
-- (never the current one if more than one exists), so the full pool
-- cycles through before anything repeats — "~6 months of unique
-- missions before repeating" from a ~26-mission pool, exactly as
-- described, without hardcoding a fixed sequence that breaks when
-- missions are added/disabled later.
-- =============================================================
CREATE OR REPLACE FUNCTION rotate_weekly_mission()
RETURNS VARCHAR AS $$
DECLARE
  v_week_start DATE := date_trunc('week', CURRENT_DATE)::DATE;
  v_week_end   DATE := v_week_start + INTERVAL '6 days';
  v_pool_size  INTEGER;
  v_chosen     VARCHAR(60);
BEGIN
  -- Already picked for this week — nothing to do.
  IF EXISTS (SELECT 1 FROM weekly_mission_rotation WHERE week_start = v_week_start) THEN
    RETURN (SELECT mission_code FROM weekly_mission_rotation WHERE week_start = v_week_start);
  END IF;

  SELECT COUNT(*) INTO v_pool_size FROM missions WHERE mission_type = 'weekly' AND is_enabled = TRUE;
  IF v_pool_size = 0 THEN
    RETURN NULL; -- no weekly missions configured yet — nothing to rotate to
  END IF;

  -- Least-recently-used enabled weekly mission (excludes the most recent
  -- (pool_size - 1) picks, so with a full pool nothing repeats until
  -- every other mission has had a turn).
  SELECT m.code INTO v_chosen
    FROM missions m
   WHERE m.mission_type = 'weekly' AND m.is_enabled = TRUE
     AND m.code NOT IN (
       SELECT mission_code FROM weekly_mission_rotation
        ORDER BY week_start DESC
        LIMIT GREATEST(v_pool_size - 1, 0)
     )
   ORDER BY RANDOM()
   LIMIT 1;

  INSERT INTO weekly_mission_rotation (mission_code, week_start, week_end)
  VALUES (v_chosen, v_week_start, v_week_end);

  RETURN v_chosen;
END;
$$ LANGUAGE plpgsql;

-- =============================================================
-- 3. THIS WEEK'S MISSION — auto-rotates on first read if nothing has
-- been picked yet, same "calculate on demand if the scheduler hasn't
-- run yet" pattern as get_daily_homepage() in Stage D.
-- =============================================================
CREATE OR REPLACE FUNCTION get_current_weekly_mission()
RETURNS TABLE (
  code           VARCHAR,
  title          VARCHAR,
  description    TEXT,
  points_reward  INTEGER,
  target_count   INTEGER,
  action_code    VARCHAR,
  week_start     DATE,
  week_end       DATE
) AS $$
DECLARE
  v_week_start DATE := date_trunc('week', CURRENT_DATE)::DATE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM weekly_mission_rotation WHERE weekly_mission_rotation.week_start = v_week_start) THEN
    PERFORM rotate_weekly_mission();
  END IF;

  RETURN QUERY
  SELECT m.code, m.title, m.description, m.points_reward, m.target_count, m.action_code,
         wr.week_start, wr.week_end
    FROM weekly_mission_rotation wr
    JOIN missions m ON m.code = wr.mission_code
   WHERE wr.week_start = v_week_start;
END;
$$ LANGUAGE plpgsql;

-- =============================================================
-- 4. ASSIGN this week's mission to a member (idempotent — one row per
-- member per week, same UNIQUE (user_id, mission_code, assigned_date)
-- constraint user_missions already has from Stage C).
-- =============================================================
CREATE OR REPLACE FUNCTION assign_weekly_mission(p_user_id INTEGER)
RETURNS VOID AS $$
DECLARE
  v_current RECORD;
BEGIN
  SELECT * INTO v_current FROM get_current_weekly_mission();
  IF v_current.code IS NULL THEN RETURN; END IF;

  INSERT INTO user_missions (user_id, mission_code, assigned_date, progress_count, is_completed)
  VALUES (p_user_id, v_current.code, v_current.week_start, 0, FALSE)
  ON CONFLICT DO NOTHING;
END;
$$ LANGUAGE plpgsql;

-- =============================================================
-- 5. UPDATE MISSION PROGRESS — extended to also match the member's
-- current weekly mission, not just today's daily ones. A weekly row's
-- assigned_date is the week's Monday, so "still current" means it falls
-- within this ISO week rather than exactly matching CURRENT_DATE.
-- CREATE OR REPLACE because the function signature is unchanged from
-- Stage C — only the body's matching logic grows a second clause.
-- =============================================================
CREATE OR REPLACE FUNCTION update_mission_progress(p_user_id INTEGER, p_action_code TEXT)
RETURNS INTEGER AS $$
DECLARE
  v_today       DATE := CURRENT_DATE;
  v_week_start  DATE := date_trunc('week', CURRENT_DATE)::DATE;
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
-- 6. SEED — weekly missions. Only real, currently-firable actions
-- (recognition_give, top10_vote — member_referral_registered already has
-- weekly_invite from Stage C) are used. This is intentionally a starter
-- pool, not the full ~26 the design calls for — the admin mission CRUD
-- below is what lets the site owner grow this pool over time as more
-- real actions get wired up (article reads/likes, directory reviews,
-- etc. in a later stage), rather than seeding missions tied to actions
-- nothing on the site can actually trigger, which would silently never
-- complete for anyone.
-- =============================================================
INSERT INTO missions (code, title, description, mission_type, action_code, points_reward, target_count) VALUES
  ('weekly_recognise5', 'Recognise 5 People', 'Give recognition to 5 different people this week.', 'weekly', 'recognition_give', 60, 5),
  ('weekly_vote10',     'Vote 10 Times', 'Cast 10 votes in the Top 10 this week.', 'weekly', 'top10_vote', 40, 10)
ON CONFLICT (code) DO NOTHING;
