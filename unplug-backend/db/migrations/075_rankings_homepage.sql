-- Participation Engine — Stage D: rankings + daily homepage engine.
--
-- Scope note: the uploaded spec's rankings supported provincial/category
-- scopes sourced from Supabase `profiles.province`/`category`. This
-- project's equivalent fields live on the Directory `profiles` table,
-- which — per the site owner's Stage B decision — is a paid service
-- listing, not every member's identity, and is intentionally kept
-- unrelated to this gamification layer. So: national/lifetime rankings
-- only for now. Display names/avatars/location shown on the leaderboard
-- and homepage are a best-effort READ-ONLY join against a Directory
-- listing when one exists (falling back to the part of the member's
-- email before the @), never a write, and never a requirement to
-- participate.
--
-- Scheduling: no pg_cron (this runs on Render's own Postgres, not
-- Supabase). See src/utils/participationScheduler.js, which drives these
-- functions the same way src/app.js already drives birthday greetings —
-- an in-process interval, not a database-level cron job.

-- =============================================================
-- 1. RANKINGS + HISTORY (national / lifetime only)
-- =============================================================
CREATE TABLE IF NOT EXISTS rankings (
  id             SERIAL PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ranking_type   VARCHAR(20) NOT NULL CHECK (ranking_type IN ('overall', 'momentum', 'recognition', 'contribution')),
  period_type    VARCHAR(20) NOT NULL DEFAULT 'lifetime',
  period_value   VARCHAR(20) NOT NULL DEFAULT 'all-time',
  rank_position  INTEGER NOT NULL,
  score_value    INTEGER NOT NULL DEFAULT 0,
  rank_movement  INTEGER NOT NULL DEFAULT 0,
  calculated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, ranking_type, period_type, period_value)
);
CREATE INDEX IF NOT EXISTS idx_rankings_lookup ON rankings(ranking_type, period_type, period_value, rank_position);
CREATE INDEX IF NOT EXISTS idx_rankings_user ON rankings(user_id);

CREATE TABLE IF NOT EXISTS ranking_history (
  id             SERIAL PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ranking_type   VARCHAR(20) NOT NULL,
  period_type    VARCHAR(20) NOT NULL,
  period_value   VARCHAR(20) NOT NULL,
  rank_position  INTEGER NOT NULL,
  score_value    INTEGER NOT NULL DEFAULT 0,
  snapshot_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ranking_history_user ON ranking_history(user_id, ranking_type, snapshot_at DESC);

-- =============================================================
-- 2. RECALCULATE MOMENTUM SCORES
-- Raw 7d/30d points plus a 0-100 index normalised against the busiest
-- member, so the leaderboard/homepage can show "momentum" as a
-- comparable number rather than a raw, unbounded point count.
-- =============================================================
CREATE OR REPLACE FUNCTION recalculate_momentum_scores()
RETURNS VOID AS $$
BEGIN
  WITH raw AS (
    SELECT user_id,
           COALESCE(SUM(CASE WHEN earned_at >= now() - INTERVAL '7 days'  THEN total_points ELSE 0 END), 0) AS pts_7d,
           COALESCE(SUM(CASE WHEN earned_at >= now() - INTERVAL '30 days' THEN total_points ELSE 0 END), 0) AS pts_30d
      FROM participation_points
     WHERE is_reversed = FALSE
     GROUP BY user_id
  ),
  normalised AS (
    SELECT user_id, pts_7d, pts_30d,
           CASE WHEN MAX(pts_7d) OVER () = 0 THEN 0
                ELSE ROUND((pts_7d::NUMERIC / NULLIF(MAX(pts_7d) OVER (), 0)) * 100)
           END::INTEGER AS momentum_index
      FROM raw
  )
  INSERT INTO momentum_scores (user_id, momentum_7d, momentum_30d, momentum_index, calculated_at)
  SELECT user_id, pts_7d, pts_30d, momentum_index, now() FROM normalised
  ON CONFLICT (user_id) DO UPDATE SET
    momentum_7d    = EXCLUDED.momentum_7d,
    momentum_30d   = EXCLUDED.momentum_30d,
    momentum_index = EXCLUDED.momentum_index,
    calculated_at  = now();
END;
$$ LANGUAGE plpgsql;

-- =============================================================
-- 3. RECALCULATE ONE RANKING (national / lifetime)
-- =============================================================
CREATE OR REPLACE FUNCTION recalculate_ranking(p_ranking_type TEXT)
RETURNS VOID AS $$
BEGIN
  IF p_ranking_type = 'momentum' THEN
    INSERT INTO rankings (user_id, ranking_type, period_type, period_value, rank_position, score_value, rank_movement, calculated_at)
    SELECT
      ms.user_id, 'momentum', 'lifetime', 'all-time',
      ROW_NUMBER() OVER (ORDER BY ms.momentum_index DESC NULLS LAST)::INTEGER,
      ms.momentum_index, 0, now()
    FROM momentum_scores ms
    JOIN users u ON u.id = ms.user_id
    ON CONFLICT (user_id, ranking_type, period_type, period_value) DO UPDATE SET
      rank_position = EXCLUDED.rank_position,
      score_value   = EXCLUDED.score_value,
      rank_movement = (
        SELECT COALESCE(rh.rank_position, EXCLUDED.rank_position) - EXCLUDED.rank_position
          FROM ranking_history rh
         WHERE rh.user_id = rankings.user_id AND rh.ranking_type = p_ranking_type
         ORDER BY rh.snapshot_at DESC LIMIT 1
      ),
      calculated_at = now();
  ELSE
    INSERT INTO rankings (user_id, ranking_type, period_type, period_value, rank_position, score_value, rank_movement, calculated_at)
    SELECT
      sc.user_id, p_ranking_type, 'lifetime', 'all-time',
      ROW_NUMBER() OVER (ORDER BY
        CASE p_ranking_type
          WHEN 'overall'      THEN sc.unplug_score
          WHEN 'recognition'  THEN sc.recognition_score
          WHEN 'contribution' THEN sc.contribution_score
        END DESC NULLS LAST
      )::INTEGER,
      CASE p_ranking_type
        WHEN 'overall'      THEN sc.unplug_score
        WHEN 'recognition'  THEN sc.recognition_score
        WHEN 'contribution' THEN sc.contribution_score
      END,
      0, now()
    FROM score_cache sc
    JOIN users u ON u.id = sc.user_id
    ON CONFLICT (user_id, ranking_type, period_type, period_value) DO UPDATE SET
      rank_position = EXCLUDED.rank_position,
      score_value   = EXCLUDED.score_value,
      rank_movement = (
        SELECT COALESCE(rh.rank_position, EXCLUDED.rank_position) - EXCLUDED.rank_position
          FROM ranking_history rh
         WHERE rh.user_id = rankings.user_id AND rh.ranking_type = p_ranking_type
         ORDER BY rh.snapshot_at DESC LIMIT 1
      ),
      calculated_at = now();
  END IF;
END;
$$ LANGUAGE plpgsql;

-- =============================================================
-- 4. RECALCULATE EVERYTHING
-- Snapshots the CURRENT rankings into history before overwriting them,
-- so the next run can compute rank_movement against this run — called
-- periodically by the in-process scheduler, not pg_cron.
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
END;
$$ LANGUAGE plpgsql;

-- =============================================================
-- 5. LEADERBOARD + BIGGEST MOVERS
-- Display name/avatar are a best-effort read-only join against a
-- Directory listing (profiles) when the member has one; otherwise the
-- part of their email before the @. Never written to, never required.
-- =============================================================
CREATE OR REPLACE FUNCTION get_leaderboard(p_ranking_type TEXT DEFAULT 'overall', p_limit INTEGER DEFAULT 50, p_offset INTEGER DEFAULT 0)
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
  WHERE r.ranking_type = p_ranking_type AND r.period_type = 'lifetime' AND r.period_value = 'all-time'
    AND COALESCE((SELECT show_on_leaderboard FROM member_participation_profiles mp WHERE mp.user_id = u.id), TRUE) = TRUE
  ORDER BY r.rank_position ASC
  LIMIT p_limit OFFSET p_offset;
$$ LANGUAGE SQL STABLE;

CREATE OR REPLACE FUNCTION get_biggest_movers(p_limit INTEGER DEFAULT 10)
RETURNS TABLE (
  user_id        INTEGER,
  display_name   TEXT,
  status_emoji   VARCHAR,
  rank_position  INTEGER,
  rank_movement  INTEGER
) AS $$
  SELECT u.id, COALESCE(dp.display_name, SPLIT_PART(u.email, '@', 1)), sl.emoji, r.rank_position, r.rank_movement
  FROM rankings r
  JOIN users u ON u.id = r.user_id
  LEFT JOIN profiles dp ON dp.user_id = u.id AND dp.status = 'approved'
  LEFT JOIN member_status_history msh ON msh.user_id = u.id AND msh.is_active_status = TRUE
  LEFT JOIN member_status_levels sl ON sl.code = msh.status_code
  WHERE r.ranking_type = 'overall' AND r.period_type = 'lifetime' AND r.period_value = 'all-time' AND r.rank_movement > 0
  ORDER BY r.rank_movement DESC
  LIMIT p_limit;
$$ LANGUAGE SQL STABLE;

-- =============================================================
-- 6. DAILY HOMEPAGE
-- =============================================================
CREATE TABLE IF NOT EXISTS daily_homepage (
  id                          SERIAL PRIMARY KEY,
  content_date                DATE NOT NULL UNIQUE DEFAULT CURRENT_DATE,
  todays_person_id            INTEGER REFERENCES users(id),
  todays_person_reason        TEXT,
  todays_person_source        VARCHAR(20),
  rising_star_id              INTEGER REFERENCES users(id),
  rising_star_score           INTEGER,
  biggest_mover_id            INTEGER REFERENCES users(id),
  biggest_mover_movement      INTEGER,
  biggest_mover_rank          INTEGER,
  most_recognised_id          INTEGER REFERENCES users(id),
  most_recognised_count       INTEGER,
  todays_achievement_user_id  INTEGER REFERENCES users(id),
  todays_achievement_code     VARCHAR(60) REFERENCES achievements(code),
  day_theme                   VARCHAR(20),
  day_theme_label             VARCHAR(60),
  calculated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_daily_homepage_date ON daily_homepage(content_date DESC);

CREATE OR REPLACE FUNCTION get_day_theme(p_date DATE DEFAULT CURRENT_DATE)
RETURNS TABLE (theme VARCHAR, label VARCHAR) AS $$
  SELECT theme, label FROM (VALUES
    ('rise',       'The Rise'),
    ('discovery',  'Discovery'),
    ('recognition','Recognition'),
    ('challenge',  'The Challenge'),
    ('top',        'The Top'),
    ('experience', 'Experience'),
    ('purpose',    'Purpose')
  ) AS t(theme, label)
  WHERE t.theme = (ARRAY['rise','discovery','recognition','challenge','top','experience','purpose'])[EXTRACT(ISODOW FROM p_date)::INTEGER]
  LIMIT 1;
$$ LANGUAGE SQL STABLE;

CREATE OR REPLACE FUNCTION calculate_daily_homepage(p_date DATE DEFAULT CURRENT_DATE)
RETURNS VOID AS $$
DECLARE
  v_rising_star_id       INTEGER;
  v_rising_star_score    INTEGER;
  v_biggest_mover_id     INTEGER;
  v_biggest_mover_mv     INTEGER;
  v_biggest_mover_rank   INTEGER;
  v_most_rec_id          INTEGER;
  v_most_rec_count       INTEGER;
  v_ach_user_id          INTEGER;
  v_ach_code             VARCHAR;
  v_todays_person_id     INTEGER;
  v_todays_person_reason TEXT;
  v_todays_person_source VARCHAR;
  v_theme                VARCHAR;
  v_theme_label          VARCHAR;
BEGIN
  SELECT ms.user_id, ms.momentum_index INTO v_rising_star_id, v_rising_star_score
    FROM momentum_scores ms JOIN users u ON u.id = ms.user_id
   WHERE u.created_at >= now() - INTERVAL '90 days'
   ORDER BY ms.momentum_index DESC NULLS LAST LIMIT 1;

  SELECT r.user_id, r.rank_movement, r.rank_position INTO v_biggest_mover_id, v_biggest_mover_mv, v_biggest_mover_rank
    FROM rankings r
   WHERE r.ranking_type = 'overall' AND r.period_type = 'lifetime' AND r.period_value = 'all-time' AND r.rank_movement > 0
   ORDER BY r.rank_movement DESC LIMIT 1;

  SELECT rec.to_user_id, COUNT(*) INTO v_most_rec_id, v_most_rec_count
    FROM recognitions rec
   WHERE rec.created_at >= now() - INTERVAL '7 days' AND rec.is_reversed = FALSE
   GROUP BY rec.to_user_id ORDER BY COUNT(*) DESC LIMIT 1;

  SELECT ua.user_id, ua.achievement_code INTO v_ach_user_id, v_ach_code
    FROM user_achievements ua JOIN achievements a ON a.code = ua.achievement_code
   WHERE ua.earned_at >= p_date AND ua.earned_at < p_date + INTERVAL '1 day'
   ORDER BY a.points_reward DESC, ua.earned_at DESC LIMIT 1;

  IF v_ach_user_id IS NOT NULL THEN
    v_todays_person_id := v_ach_user_id;
    v_todays_person_source := 'achievement';
    SELECT 'Just earned the ' || a.emoji || ' ' || a.label || ' achievement!' INTO v_todays_person_reason
      FROM achievements a WHERE a.code = v_ach_code;
  ELSIF v_biggest_mover_id IS NOT NULL THEN
    v_todays_person_id := v_biggest_mover_id;
    v_todays_person_source := 'biggest_mover';
    v_todays_person_reason := 'Moved up ' || v_biggest_mover_mv || ' positions this week.';
  ELSIF v_most_rec_id IS NOT NULL THEN
    v_todays_person_id := v_most_rec_id;
    v_todays_person_source := 'recognition';
    v_todays_person_reason := 'Received ' || v_most_rec_count || ' recognitions this week.';
  ELSIF v_rising_star_id IS NOT NULL THEN
    v_todays_person_id := v_rising_star_id;
    v_todays_person_source := 'rising_star';
    v_todays_person_reason := 'One of the fastest-rising new members on Unplug.';
  END IF;

  SELECT theme, label INTO v_theme, v_theme_label FROM get_day_theme(p_date);

  INSERT INTO daily_homepage (
    content_date, todays_person_id, todays_person_reason, todays_person_source,
    rising_star_id, rising_star_score, biggest_mover_id, biggest_mover_movement, biggest_mover_rank,
    most_recognised_id, most_recognised_count, todays_achievement_user_id, todays_achievement_code,
    day_theme, day_theme_label, calculated_at
  ) VALUES (
    p_date, v_todays_person_id, v_todays_person_reason, v_todays_person_source,
    v_rising_star_id, v_rising_star_score, v_biggest_mover_id, v_biggest_mover_mv, v_biggest_mover_rank,
    v_most_rec_id, v_most_rec_count, v_ach_user_id, v_ach_code,
    v_theme, v_theme_label, now()
  )
  ON CONFLICT (content_date) DO UPDATE SET
    todays_person_id = EXCLUDED.todays_person_id,
    todays_person_reason = EXCLUDED.todays_person_reason,
    todays_person_source = EXCLUDED.todays_person_source,
    rising_star_id = EXCLUDED.rising_star_id,
    rising_star_score = EXCLUDED.rising_star_score,
    biggest_mover_id = EXCLUDED.biggest_mover_id,
    biggest_mover_movement = EXCLUDED.biggest_mover_movement,
    biggest_mover_rank = EXCLUDED.biggest_mover_rank,
    most_recognised_id = EXCLUDED.most_recognised_id,
    most_recognised_count = EXCLUDED.most_recognised_count,
    todays_achievement_user_id = EXCLUDED.todays_achievement_user_id,
    todays_achievement_code = EXCLUDED.todays_achievement_code,
    day_theme = EXCLUDED.day_theme,
    day_theme_label = EXCLUDED.day_theme_label,
    calculated_at = now();

  IF v_todays_person_id IS NOT NULL THEN
    INSERT INTO notifications (user_id, type, title, body, link_url)
    VALUES (v_todays_person_id, 'featured', '🌟 You are today''s featured person on Unplug!',
      COALESCE(v_todays_person_reason, '') || ' Share your moment.', '/unplug-member-dashboard.html')
    ON CONFLICT DO NOTHING;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Returns the enriched payload for today (calculating it first if it
-- doesn't exist yet — e.g. the very first request of a new day, before
-- the scheduler's next run).
CREATE OR REPLACE FUNCTION get_daily_homepage(p_date DATE DEFAULT CURRENT_DATE)
RETURNS JSON AS $$
DECLARE
  v_result JSON;
BEGIN
  SELECT json_build_object(
    'date', dh.content_date, 'day_theme', dh.day_theme, 'day_theme_label', dh.day_theme_label,
    'todays_person', CASE WHEN dh.todays_person_id IS NOT NULL THEN json_build_object(
      'user_id', dh.todays_person_id,
      'display_name', COALESCE(tp.display_name, SPLIT_PART(tu.email, '@', 1)),
      'avatar_url', tp.feature_image_url,
      'status_emoji', tsl.emoji, 'status_label', tsl.label,
      'unplug_score', tsc.unplug_score, 'reason', dh.todays_person_reason, 'source', dh.todays_person_source
    ) ELSE NULL END,
    'rising_star', CASE WHEN dh.rising_star_id IS NOT NULL THEN json_build_object(
      'user_id', dh.rising_star_id,
      'display_name', COALESCE(rsp.display_name, SPLIT_PART(rsu.email, '@', 1)),
      'avatar_url', rsp.feature_image_url, 'status_emoji', rssl.emoji, 'momentum_score', dh.rising_star_score
    ) ELSE NULL END,
    'biggest_mover', CASE WHEN dh.biggest_mover_id IS NOT NULL THEN json_build_object(
      'user_id', dh.biggest_mover_id,
      'display_name', COALESCE(bmp.display_name, SPLIT_PART(bmu.email, '@', 1)),
      'avatar_url', bmp.feature_image_url, 'status_emoji', bmsl.emoji,
      'rank_position', dh.biggest_mover_rank, 'rank_movement', dh.biggest_mover_movement
    ) ELSE NULL END,
    'most_recognised', CASE WHEN dh.most_recognised_id IS NOT NULL THEN json_build_object(
      'user_id', dh.most_recognised_id,
      'display_name', COALESCE(mrp.display_name, SPLIT_PART(mru.email, '@', 1)),
      'avatar_url', mrp.feature_image_url, 'status_emoji', mrsl.emoji, 'recognition_count', dh.most_recognised_count
    ) ELSE NULL END,
    'todays_achievement', CASE WHEN dh.todays_achievement_user_id IS NOT NULL THEN json_build_object(
      'user_id', dh.todays_achievement_user_id,
      'display_name', COALESCE(acp.display_name, SPLIT_PART(acu.email, '@', 1)),
      'achievement_emoji', ach.emoji, 'achievement_label', ach.label
    ) ELSE NULL END,
    'calculated_at', dh.calculated_at
  ) INTO v_result
  FROM daily_homepage dh
  LEFT JOIN users tu ON tu.id = dh.todays_person_id
  LEFT JOIN profiles tp ON tp.user_id = tu.id AND tp.status = 'approved'
  LEFT JOIN member_status_history tush ON tush.user_id = tu.id AND tush.is_active_status = TRUE
  LEFT JOIN member_status_levels tsl ON tsl.code = tush.status_code
  LEFT JOIN score_cache tsc ON tsc.user_id = tu.id
  LEFT JOIN users rsu ON rsu.id = dh.rising_star_id
  LEFT JOIN profiles rsp ON rsp.user_id = rsu.id AND rsp.status = 'approved'
  LEFT JOIN member_status_history rsush ON rsush.user_id = rsu.id AND rsush.is_active_status = TRUE
  LEFT JOIN member_status_levels rssl ON rssl.code = rsush.status_code
  LEFT JOIN users bmu ON bmu.id = dh.biggest_mover_id
  LEFT JOIN profiles bmp ON bmp.user_id = bmu.id AND bmp.status = 'approved'
  LEFT JOIN member_status_history bmush ON bmush.user_id = bmu.id AND bmush.is_active_status = TRUE
  LEFT JOIN member_status_levels bmsl ON bmsl.code = bmush.status_code
  LEFT JOIN users mru ON mru.id = dh.most_recognised_id
  LEFT JOIN profiles mrp ON mrp.user_id = mru.id AND mrp.status = 'approved'
  LEFT JOIN member_status_history mrush ON mrush.user_id = mru.id AND mrush.is_active_status = TRUE
  LEFT JOIN member_status_levels mrsl ON mrsl.code = mrush.status_code
  LEFT JOIN users acu ON acu.id = dh.todays_achievement_user_id
  LEFT JOIN profiles acp ON acp.user_id = acu.id AND acp.status = 'approved'
  LEFT JOIN achievements ach ON ach.code = dh.todays_achievement_code
  WHERE dh.content_date = p_date;

  IF v_result IS NULL THEN
    PERFORM calculate_daily_homepage(p_date);
    SELECT get_daily_homepage(p_date) INTO v_result;
  END IF;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql;
