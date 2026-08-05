-- Participation Engine — Stage C: Recognition, Achievements, Passport,
-- Missions.
--
-- Recognition is kept as its OWN feature, deliberately separate from the
-- existing Shoutouts system (daily featured member) — confirmed with the
-- site owner: both stay, they serve different moments (a spontaneous
-- one-off "you're seen" badge from a peer vs. an editorial daily
-- spotlight).

-- =============================================================
-- 1. RECOGNITION TYPES + RECOGNITIONS
-- =============================================================
CREATE TABLE IF NOT EXISTS recognition_types (
  code        VARCHAR(30) PRIMARY KEY,
  label       VARCHAR(60) NOT NULL,
  emoji       VARCHAR(10) NOT NULL,
  description TEXT,
  is_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS recognitions (
  id                SERIAL PRIMARY KEY,
  from_user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recognition_type  VARCHAR(30) NOT NULL REFERENCES recognition_types(code),
  message           TEXT,
  is_public         BOOLEAN NOT NULL DEFAULT TRUE,
  is_reversed       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT no_self_recognition CHECK (from_user_id <> to_user_id),
  CONSTRAINT one_recognition_type_per_pair UNIQUE (from_user_id, to_user_id, recognition_type)
);
CREATE INDEX IF NOT EXISTS idx_recognitions_to ON recognitions(to_user_id, is_reversed, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recognitions_from ON recognitions(from_user_id);

-- Materialised per-user counts (fast reads for a profile/dashboard).
-- One column per recognition type, kept in sync by process_recognition().
CREATE TABLE IF NOT EXISTS recognition_counts (
  user_id                INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  total_received         INTEGER NOT NULL DEFAULT 0,
  total_given            INTEGER NOT NULL DEFAULT 0,
  inspiring_count        INTEGER NOT NULL DEFAULT 0,
  innovative_count       INTEGER NOT NULL DEFAULT 0,
  creative_count         INTEGER NOT NULL DEFAULT 0,
  entrepreneurial_count  INTEGER NOT NULL DEFAULT 0,
  community_builder_count INTEGER NOT NULL DEFAULT 0,
  rising_talent_count    INTEGER NOT NULL DEFAULT 0,
  proudly_sa_count       INTEGER NOT NULL DEFAULT 0,
  local_hero_count       INTEGER NOT NULL DEFAULT 0,
  helpful_count          INTEGER NOT NULL DEFAULT 0,
  purpose_driven_count   INTEGER NOT NULL DEFAULT 0,
  outstanding_count      INTEGER NOT NULL DEFAULT 0,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================
-- 2. ACHIEVEMENTS
-- =============================================================
CREATE TABLE IF NOT EXISTS achievements (
  code            VARCHAR(60) PRIMARY KEY,
  label           VARCHAR(120) NOT NULL,
  description     TEXT NOT NULL,
  emoji           VARCHAR(10) NOT NULL,
  category        VARCHAR(30) NOT NULL,
  points_reward   INTEGER NOT NULL DEFAULT 0,
  is_enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  -- Free-form JSON, evaluated by sync_achievements() below. Not FK-checked
  -- against participation_actions, so an achievement can reference an
  -- action_code that doesn't exist yet (e.g. one a later stage adds) —
  -- it simply never qualifies until that action starts being awarded.
  trigger_config  JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_achievements (
  id               SERIAL PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  achievement_code VARCHAR(60) NOT NULL REFERENCES achievements(code),
  earned_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  context_data     JSONB DEFAULT '{}',
  is_featured      BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (user_id, achievement_code)
);
CREATE INDEX IF NOT EXISTS idx_user_achievements_user ON user_achievements(user_id);

-- =============================================================
-- 3. PASSPORT
-- =============================================================
CREATE TABLE IF NOT EXISTS passport_items (
  code            VARCHAR(60) PRIMARY KEY,
  label           VARCHAR(120) NOT NULL,
  emoji           VARCHAR(10) NOT NULL,
  category        VARCHAR(30) NOT NULL,
  description     TEXT,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  is_enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  trigger_config  JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS user_passport (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  passport_code VARCHAR(60) NOT NULL REFERENCES passport_items(code),
  earned_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  context_data  JSONB DEFAULT '{}',
  UNIQUE (user_id, passport_code)
);
CREATE INDEX IF NOT EXISTS idx_user_passport_user ON user_passport(user_id);

-- =============================================================
-- 4. MISSIONS
-- =============================================================
CREATE TABLE IF NOT EXISTS missions (
  code              VARCHAR(60) PRIMARY KEY,
  title             VARCHAR(120) NOT NULL,
  description       TEXT NOT NULL,
  mission_type      VARCHAR(10) NOT NULL DEFAULT 'daily'
    CHECK (mission_type IN ('daily', 'weekly', 'challenge')),
  action_code       VARCHAR(60) REFERENCES participation_actions(code),
  points_reward     INTEGER NOT NULL DEFAULT 0,
  achievement_code  VARCHAR(60) REFERENCES achievements(code),
  target_count      INTEGER NOT NULL DEFAULT 1,
  is_enabled        BOOLEAN NOT NULL DEFAULT TRUE,
  min_status_rank   INTEGER NOT NULL DEFAULT 0,
  max_status_rank   INTEGER NOT NULL DEFAULT 99,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_missions (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mission_code    VARCHAR(60) NOT NULL REFERENCES missions(code),
  assigned_date   DATE NOT NULL DEFAULT CURRENT_DATE,
  progress_count  INTEGER NOT NULL DEFAULT 0,
  is_completed    BOOLEAN NOT NULL DEFAULT FALSE,
  completed_at    TIMESTAMPTZ,
  points_tx_id    INTEGER,
  UNIQUE (user_id, mission_code, assigned_date)
);
CREATE INDEX IF NOT EXISTS idx_user_missions_user ON user_missions(user_id, assigned_date);

-- =============================================================
-- 5. AWARD A PASSPORT STAMP
-- =============================================================
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

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

-- =============================================================
-- 6. SYNC PASSPORT
-- Evaluates every enabled passport item against the user's current
-- state and awards any not yet earned. Safe to call repeatedly.
-- =============================================================
CREATE OR REPLACE FUNCTION sync_passport(p_user_id INTEGER)
RETURNS INTEGER AS $$
DECLARE
  v_item      passport_items%ROWTYPE;
  v_awarded   INTEGER := 0;
  v_qualifies BOOLEAN;
BEGIN
  FOR v_item IN SELECT * FROM passport_items WHERE is_enabled = TRUE LOOP
    CONTINUE WHEN EXISTS (SELECT 1 FROM user_passport WHERE user_id = p_user_id AND passport_code = v_item.code);

    v_qualifies := FALSE;
    IF v_item.trigger_config ? 'status_code' THEN
      v_qualifies := EXISTS (
        SELECT 1 FROM member_status_history
         WHERE user_id = p_user_id AND status_code = v_item.trigger_config->>'status_code'
      );
    ELSIF v_item.trigger_config ? 'action_code' THEN
      v_qualifies := EXISTS (
        SELECT 1 FROM participation_points
         WHERE user_id = p_user_id AND action_code = v_item.trigger_config->>'action_code' AND is_reversed = FALSE
      );
    END IF;

    IF v_qualifies THEN
      PERFORM award_passport_stamp(p_user_id, v_item.code, '{}'::JSONB);
      v_awarded := v_awarded + 1;
    END IF;
  END LOOP;
  RETURN v_awarded;
END;
$$ LANGUAGE plpgsql;

-- =============================================================
-- 7. SYNC ACHIEVEMENTS
-- =============================================================
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

      v_awarded := v_awarded + 1;
    END IF;
  END LOOP;

  PERFORM sync_passport(p_user_id);
  RETURN v_awarded;
END;
$$ LANGUAGE plpgsql;

-- =============================================================
-- 8. PROCESS A RECOGNITION
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

  RETURN QUERY SELECT TRUE, v_rec_id, NULL::TEXT;
END;
$$ LANGUAGE plpgsql;

-- =============================================================
-- 9. MISSIONS: ASSIGNMENT + PROGRESS
-- =============================================================
CREATE OR REPLACE FUNCTION assign_daily_missions(p_user_id INTEGER)
RETURNS INTEGER AS $$
DECLARE
  v_today       DATE := CURRENT_DATE;
  v_status_rank INTEGER;
  v_mission     missions%ROWTYPE;
  v_assigned    INTEGER := 0;
  v_max_daily   CONSTANT INTEGER := 3;
  v_have_today  INTEGER;
BEGIN
  v_status_rank := get_user_status_rank(p_user_id);
  SELECT COUNT(*) INTO v_have_today FROM user_missions WHERE user_id = p_user_id AND assigned_date = v_today;
  IF v_have_today >= v_max_daily THEN RETURN 0; END IF;

  FOR v_mission IN
    SELECT m.* FROM missions m
     WHERE m.mission_type = 'daily' AND m.is_enabled = TRUE
       AND v_status_rank BETWEEN m.min_status_rank AND m.max_status_rank
       AND NOT EXISTS (
         SELECT 1 FROM user_missions um
          WHERE um.user_id = p_user_id AND um.mission_code = m.code AND um.assigned_date = v_today
       )
     ORDER BY RANDOM()
     LIMIT (v_max_daily - v_have_today)
  LOOP
    INSERT INTO user_missions (user_id, mission_code, assigned_date, progress_count, is_completed)
    VALUES (p_user_id, v_mission.code, v_today, 0, FALSE)
    ON CONFLICT DO NOTHING;
    v_assigned := v_assigned + 1;
  END LOOP;

  RETURN v_assigned;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION update_mission_progress(p_user_id INTEGER, p_action_code TEXT)
RETURNS INTEGER AS $$
DECLARE
  v_today     DATE := CURRENT_DATE;
  v_mission   user_missions%ROWTYPE;
  v_def       missions%ROWTYPE;
  v_completed INTEGER := 0;
  v_tx        RECORD;
BEGIN
  FOR v_mission IN
    SELECT um.* FROM user_missions um
    JOIN missions m ON m.code = um.mission_code
    WHERE um.user_id = p_user_id AND um.assigned_date = v_today
      AND um.is_completed = FALSE AND m.action_code = p_action_code
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
-- 10. SEED — recognition-related point actions.
-- No daily limit on RECEIVING (a member can't game how many people
-- recognise them); giving is capped to keep it meaningful.
-- =============================================================
INSERT INTO participation_actions (code, label, category_code, base_points, daily_limit, weekly_limit, unique_per_object, counts_for_active_month, counts_as_meaningful, counts_as_contribution)
VALUES
  ('recognition_give',    'Recognise someone',   'community', 20, 5,   20, FALSE, TRUE, TRUE, TRUE),
  ('recognition_receive', 'Receive recognition',  'community', 25, NULL, NULL, FALSE, TRUE, TRUE, TRUE),
  ('achievement_earned',  'Achievement reward points', 'achievement', 0, NULL, NULL, FALSE, FALSE, FALSE, FALSE),
  ('mission_complete',    'Complete a daily mission', 'community', 0, NULL, NULL, FALSE, TRUE, TRUE, FALSE)
ON CONFLICT (code) DO NOTHING;

-- =============================================================
-- 11. SEED — recognition types.
-- =============================================================
INSERT INTO recognition_types (code, label, emoji, sort_order) VALUES
  ('inspiring',         'Inspiring',             '❤️',  1),
  ('innovative',        'Innovative',            '💡',  2),
  ('creative',          'Creative',              '🎨',  3),
  ('entrepreneurial',   'Entrepreneurial',       '🚀',  4),
  ('community_builder', 'Community Builder',     '🤝',  5),
  ('rising_talent',     'Rising Talent',         '🌱',  6),
  ('proudly_sa',        'Proudly South African', '🇿🇦', 7),
  ('local_hero',        'Local Hero',            '⭐',  8),
  ('helpful',           'Helpful',               '💬',  9),
  ('purpose_driven',    'Purpose Driven',        '🎯', 10),
  ('outstanding',       'Outstanding',           '🏆', 11)
ON CONFLICT (code) DO NOTHING;

-- =============================================================
-- 12. SEED — achievements (status- and recognition/referral-based only;
-- content-specific achievements are added by whichever later stage
-- introduces the underlying action, so codes referenced here always
-- correspond to something real by the time it can actually fire).
-- =============================================================
INSERT INTO achievements (code, label, description, emoji, category, points_reward, sort_order, trigger_config) VALUES
  ('recognised',          'Recognised',           'You received your first recognition from the community.', '❤️', 'recognition', 10,  1, '{"action_code": "recognition_receive", "cumulative_count": 1}'),
  ('warm_welcome',        'Warm Welcome',         'You gave your first recognition to someone else.',         '🤗', 'community',   5,   2, '{"action_code": "recognition_give", "cumulative_count": 1}'),
  ('connector',            'Connector',            'Your first invited friend became an active member.',       '🤝', 'community',   50,  3, '{"action_code": "member_referral_qualified", "cumulative_count": 1}'),
  ('community_builder_ach','Community Builder',   'You generated 10 genuinely active referrals.',              '🌟', 'community',   100, 4, '{"action_code": "member_referral_qualified", "cumulative_count": 10}'),
  ('widely_recognised',    'Widely Recognised',   'You have received 100 recognitions from the community.',   '❤️', 'recognition', 200, 5, '{"action_code": "recognition_receive", "cumulative_count": 100}'),
  ('unplug_icon',          'Unplug Icon',          'You reached Rising Icon status.',                          '💎', 'status',      100, 6, '{"status_code": "rising_icon"}'),
  ('influence_matters',    'Influence Matters',   'You reached Global Influencer status.',                    '🌍', 'status',      500, 7, '{"status_code": "global_influencer"}'),
  ('member_hof_badge',     'Hall of Fame',         'You were inducted into the Unplug member Hall of Fame.',  '⭐', 'status',      1000,8, '{"status_code": "member_hall_of_fame"}')
ON CONFLICT (code) DO NOTHING;

-- =============================================================
-- 13. SEED — passport items (one per status level, plus the two
-- currently-real action milestones).
-- =============================================================
INSERT INTO passport_items (code, label, emoji, category, sort_order, trigger_config) VALUES
  ('status_explorer',           'Explorer',             '🌱', 'status', 1, '{"status_code": "explorer"}'),
  ('status_trailblazer',        'Trailblazer',          '🚀', 'status', 2, '{"status_code": "trailblazer"}'),
  ('status_rising_icon',        'Rising Icon',          '💎', 'status', 3, '{"status_code": "rising_icon"}'),
  ('status_legend',             'Legend',               '👑', 'status', 4, '{"status_code": "legend"}'),
  ('status_global_influencer',  'Global Influencer',    '🌍', 'status', 5, '{"status_code": "global_influencer"}'),
  ('status_member_hall_of_fame','Hall of Fame',         '⭐', 'status', 6, '{"status_code": "member_hall_of_fame"}'),
  ('recognised_member',         'Recognised by Community','❤️','recognition', 10, '{"action_code": "recognition_receive"}'),
  ('community_connector',       'Community Connector',  '🤝', 'community', 11, '{"action_code": "member_referral_qualified"}')
ON CONFLICT (code) DO NOTHING;

-- =============================================================
-- 14. SEED — missions (only ones whose action_code already exists,
-- since missions.action_code is FK-checked).
-- =============================================================
INSERT INTO missions (code, title, description, mission_type, action_code, points_reward, target_count) VALUES
  ('daily_recognise', 'Recognise Someone', 'Recognise someone who deserves to be seen today.', 'daily', 'recognition_give', 15, 1),
  ('weekly_invite',   'Invite a Friend',   'Invite someone new to Unplug with your referral link.', 'weekly', 'member_referral_registered', 20, 1)
ON CONFLICT (code) DO NOTHING;
