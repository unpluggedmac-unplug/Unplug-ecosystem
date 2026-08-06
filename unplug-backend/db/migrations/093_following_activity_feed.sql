-- Members, Profile Social Interaction & Community System — brief item 9:
-- Following Activity Feed. Followers get notified when someone they follow
-- unlocks a badge, an achievement, a passport stamp, receives recognition,
-- or levels up (member or business status).
--
-- Scoped to the trigger points that already fire from one clean, isolated
-- SQL function each — award_badge, sync_achievements, award_passport_stamp,
-- process_recognition, check_and_update_status, check_and_update_business_status.
-- The brief's other named triggers (competition wins, article/gallery/event
-- publishing, leaderboard moves, verification, challenge completion) live
-- inside shared, heavily-used generic routes/functions (the article/gallery/
-- event PATCH routes, the ranking scheduler, admin verify) where adding a
-- fan-out is materially riskier for materially less-discrete value — a
-- leaderboard "move" in particular has no single moment, since the whole
-- table is recalculated together. Left alone rather than bolted on
-- speculatively; a future migration can extend fan_out_following_activity's
-- call sites the same way this one adds its six.
--
-- One row per follower, via INSERT ... SELECT rather than a per-follower
-- loop — a popular member's follower count could be in the thousands, and
-- this way it is one statement regardless.

INSERT INTO settings (key, value) VALUES ('notify_following_activity_enabled', 'true')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION fan_out_following_activity(
  p_actor_user_id INTEGER,
  p_emoji         TEXT,
  p_verb          TEXT,
  p_link_url      TEXT DEFAULT '/unplug-member-dashboard.html'
)
RETURNS INTEGER AS $$
DECLARE
  v_actor_name TEXT;
  v_count      INTEGER;
BEGIN
  IF COALESCE((SELECT value FROM settings WHERE key = 'notify_following_activity_enabled'), 'true') = 'false' THEN
    RETURN 0;
  END IF;

  SELECT COALESCE(pr.display_name, SPLIT_PART(u.email, '@', 1)) INTO v_actor_name
    FROM users u LEFT JOIN profiles pr ON pr.user_id = u.id
   WHERE u.id = p_actor_user_id;

  INSERT INTO notifications (user_id, type, title, body, link_url)
  SELECT mf.follower_user_id, 'following_activity',
         p_emoji || ' ' || v_actor_name,
         v_actor_name || ' ' || p_verb,
         p_link_url
    FROM member_follows mf
   WHERE mf.followed_user_id = p_actor_user_id;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql;

-- Each function below is re-declared in full with one added PERFORM/CALL —
-- everything else is byte-for-byte identical to its prior version (091 for
-- award_badge, 074 for sync_achievements/award_passport_stamp, 083 for
-- process_recognition, 072 for check_and_update_status, 079 for
-- check_and_update_business_status).

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

  IF COALESCE((SELECT value FROM settings WHERE key = 'notify_badge_enabled'), 'true') <> 'false' THEN
    INSERT INTO notifications (user_id, type, title, body, link_url)
    VALUES (p_user_id, 'badge', v_badge.emoji || ' Badge earned: ' || v_badge.label,
      COALESCE(p_reason, v_badge.description), '/unplug-member-dashboard.html');
  END IF;

  PERFORM fan_out_following_activity(p_user_id, v_badge.emoji, 'earned the "' || v_badge.label || '" badge');

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION award_passport_stamp(
  p_user_id       INTEGER,
  p_passport_code TEXT,
  p_context_data  JSONB DEFAULT '{}'
)
RETURNS BOOLEAN AS $$
DECLARE
  v_item   passport_items%ROWTYPE;
  v_exists BOOLEAN;
BEGIN
  SELECT * INTO v_item FROM passport_items WHERE code = p_passport_code AND is_enabled = TRUE;
  IF NOT FOUND THEN RETURN FALSE; END IF;

  SELECT EXISTS(SELECT 1 FROM user_passport WHERE user_id = p_user_id AND passport_code = p_passport_code) INTO v_exists;
  IF v_exists THEN RETURN FALSE; END IF;

  INSERT INTO user_passport (user_id, passport_code, context_data) VALUES (p_user_id, p_passport_code, p_context_data);

  INSERT INTO notifications (user_id, type, title, body, link_url)
  VALUES (p_user_id, 'passport', v_item.emoji || ' Passport stamp earned: ' || v_item.label,
          'Your Unplug Passport has been updated.', '/unplug-member-dashboard.html');

  PERFORM fan_out_following_activity(p_user_id, v_item.emoji, 'earned the "' || v_item.label || '" passport stamp');

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION sync_achievements(p_user_id INTEGER)
RETURNS INTEGER AS $$
DECLARE
  v_ach       achievements%ROWTYPE;
  v_awarded   INTEGER := 0;
  v_trigger   JSONB;
  v_qualifies BOOLEAN;
  v_count     INTEGER;
BEGIN
  FOR v_ach IN SELECT * FROM achievements WHERE is_enabled = TRUE LOOP
    CONTINUE WHEN EXISTS (SELECT 1 FROM user_achievements WHERE user_id = p_user_id AND achievement_code = v_ach.code);

    v_trigger := v_ach.trigger_config;
    v_qualifies := FALSE;

    IF v_trigger ? 'action_code' THEN
      SELECT COUNT(*) INTO v_count FROM participation_points
       WHERE user_id = p_user_id AND action_code = v_trigger->>'action_code' AND is_reversed = FALSE;
      v_qualifies := v_count >= COALESCE((v_trigger->>'cumulative_count')::INTEGER, 1);
    ELSIF v_trigger ? 'recognition_received' THEN
      SELECT COUNT(*) INTO v_count FROM recognitions WHERE to_user_id = p_user_id AND is_reversed = FALSE;
      v_qualifies := v_count >= (v_trigger->>'recognition_received')::INTEGER;
    ELSIF v_trigger ? 'status_code' THEN
      v_qualifies := EXISTS (
        SELECT 1 FROM member_status_history WHERE user_id = p_user_id AND status_code = v_trigger->>'status_code'
      );
    END IF;

    IF v_qualifies THEN
      INSERT INTO user_achievements (user_id, achievement_code, context_data)
      VALUES (p_user_id, v_ach.code, v_trigger)
      ON CONFLICT DO NOTHING;

      IF v_ach.points_reward > 0 THEN
        PERFORM award_points(
          p_user_id       := p_user_id,
          p_action_code   := 'achievement_earned',
          p_base_override := v_ach.points_reward,
          p_source        := 'system',
          p_notes         := 'Achievement reward: ' || v_ach.code
        );
      END IF;

      INSERT INTO notifications (user_id, type, title, body, link_url)
      VALUES (p_user_id, 'achievement', v_ach.emoji || ' Achievement unlocked: ' || v_ach.label,
              v_ach.description, '/unplug-member-dashboard.html');

      PERFORM fan_out_following_activity(p_user_id, v_ach.emoji, 'unlocked the "' || v_ach.label || '" achievement');

      v_awarded := v_awarded + 1;
    END IF;
  END LOOP;

  PERFORM sync_passport(p_user_id);
  RETURN v_awarded;
END;
$$ LANGUAGE plpgsql;

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

  PERFORM fan_out_following_activity(p_to_user_id, v_rec_type.emoji, 'was recognised as ' || v_rec_type.label);

  RETURN QUERY SELECT TRUE, v_rec_id, NULL::TEXT;
END;
$$ LANGUAGE plpgsql;

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

  PERFORM fan_out_following_activity(p_user_id, v_new_status.emoji, 'reached ' || v_new_status.label || ' status');

  RETURN 'promoted_to_' || v_new_status.code;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION check_and_update_business_status(p_profile_id INTEGER)
RETURNS TEXT AS $$
DECLARE
  v_type          VARCHAR;
  v_owner_id      INTEGER;
  v_metrics       RECORD;
  v_current_rank  INTEGER;
  v_new_status    business_status_levels%ROWTYPE;
BEGIN
  SELECT type, user_id INTO v_type, v_owner_id FROM profiles WHERE id = p_profile_id;
  IF NOT FOUND OR v_type <> 'business' THEN RETURN 'not_a_business'; END IF;

  SELECT * INTO v_metrics FROM get_business_metrics(p_profile_id);
  v_current_rank := get_business_status_rank(p_profile_id);

  SELECT * INTO v_new_status FROM business_status_levels
   WHERE is_hall_of_fame = FALSE AND requires_admin_approval = FALSE
     AND rank_order > v_current_rank
     AND min_reviews <= v_metrics.reviews_count
     AND min_avg_rating <= v_metrics.avg_rating
     AND min_gallery_images <= v_metrics.gallery_count
     AND min_days_listed <= v_metrics.days_listed
   ORDER BY rank_order DESC LIMIT 1;

  IF NOT FOUND THEN RETURN 'no_new_status'; END IF;

  UPDATE business_status_history SET is_active_status = FALSE WHERE profile_id = p_profile_id AND is_active_status = TRUE;

  INSERT INTO business_status_history (
    profile_id, status_code, previous_status, reviews_at_time, avg_rating_at_time, gallery_at_time, days_listed_at_time, is_active_status
  ) VALUES (
    p_profile_id, v_new_status.code,
    (SELECT status_code FROM business_status_history WHERE profile_id = p_profile_id ORDER BY achieved_at DESC LIMIT 1),
    v_metrics.reviews_count, v_metrics.avg_rating, v_metrics.gallery_count, v_metrics.days_listed, TRUE
  );

  IF v_owner_id IS NOT NULL THEN
    INSERT INTO notifications (user_id, type, title, body, link_url)
    VALUES (
      v_owner_id, 'status_change',
      'Your business reached ' || v_new_status.emoji || ' ' || v_new_status.label || '!',
      'Your Directory listing''s standing has levelled up.',
      '/unplug-member-dashboard.html'
    );
    PERFORM fan_out_following_activity(v_owner_id, v_new_status.emoji, 'business reached ' || v_new_status.label || ' status');
  END IF;

  RETURN 'promoted_to_' || v_new_status.code;
END;
$$ LANGUAGE plpgsql;
