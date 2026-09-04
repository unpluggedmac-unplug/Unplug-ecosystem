-- Let a member mark a daily/weekly/monthly mission complete themselves,
-- from the dashboard, instead of only ever completing invisibly the moment
-- the real tracked action happens elsewhere on the site.
--
-- Requested directly, after being asked and confirmed: this is deliberately
-- a trust-based self-report -- clicking "Mark as complete" awards the
-- mission's points immediately, no proof required, same as ticking off a
-- paper to-do list. It does not replace or disable the existing automatic
-- path (update_mission_progress, unchanged) -- a mission can still complete
-- itself from real behaviour; this just adds a second, manual way to finish
-- the same row, reusing the exact same award_points() + notification +
-- achievement-sync sequence so nothing about how points are scored changes.

CREATE OR REPLACE FUNCTION complete_mission_manually(p_user_id INTEGER, p_mission_code TEXT)
RETURNS TABLE(ok BOOLEAN, message TEXT, points_awarded INTEGER) AS $$
DECLARE
  v_today       DATE := CURRENT_DATE;
  v_week_start  DATE := date_trunc('week', CURRENT_DATE)::DATE;
  v_month_start DATE := date_trunc('month', CURRENT_DATE)::DATE;
  v_mission     user_missions%ROWTYPE;
  v_def         missions%ROWTYPE;
  v_tx          RECORD;
BEGIN
  SELECT * INTO v_def FROM missions WHERE code = p_mission_code;
  IF v_def.code IS NULL THEN
    RETURN QUERY SELECT FALSE, 'Unknown mission.', 0;
    RETURN;
  END IF;

  SELECT um.* INTO v_mission FROM user_missions um
   WHERE um.user_id = p_user_id AND um.mission_code = p_mission_code
     AND (
       (v_def.mission_type = 'daily' AND um.assigned_date = v_today)
       OR (v_def.mission_type = 'weekly' AND um.assigned_date = v_week_start)
       OR (v_def.mission_type = 'challenge' AND um.assigned_date = v_month_start)
     );

  IF v_mission.id IS NULL THEN
    RETURN QUERY SELECT FALSE, 'This mission is not currently assigned to you.', 0;
    RETURN;
  END IF;
  IF v_mission.is_completed THEN
    RETURN QUERY SELECT FALSE, 'Already completed.', 0;
    RETURN;
  END IF;

  UPDATE user_missions SET progress_count = v_def.target_count WHERE id = v_mission.id;

  SELECT ap.tx_id INTO v_tx FROM award_points(
    p_user_id       := p_user_id,
    p_action_code   := 'mission_complete',
    p_base_override := v_def.points_reward,
    p_source        := 'system',
    p_notes         := 'Mission completed (self-reported): ' || v_def.code
  ) AS ap;

  UPDATE user_missions SET is_completed = TRUE, completed_at = now(), points_tx_id = v_tx.tx_id
   WHERE id = v_mission.id;

  INSERT INTO notifications (user_id, type, title, body, link_url)
  VALUES (p_user_id, 'mission', '🎯 Mission complete: ' || v_def.title,
    'You earned ' || v_def.points_reward || ' points.', '/unplug-member-dashboard.html');

  IF v_def.achievement_code IS NOT NULL THEN
    PERFORM sync_achievements(p_user_id);
  END IF;

  RETURN QUERY SELECT TRUE, 'Mission completed.', v_def.points_reward;
END;
$$ LANGUAGE plpgsql;
