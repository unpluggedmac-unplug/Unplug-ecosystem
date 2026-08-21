-- Admins do not appear on the member leaderboard.
--
-- The owner's own account was sitting at #1 with 16 points, above the members
-- the board exists to celebrate. Running the site is not competing in it.
--
-- WHY THIS FILTERS AT COMPUTE TIME, NOT AT READ TIME.
--
-- rank_position is assigned by ROW_NUMBER() when the rankings table is built.
-- Filtering an admin out when the board is READ would leave the gap behind:
-- the top member would still carry rank 2, and the leaderboard would start at
-- "#2" and look broken. Excluding before ROW_NUMBER() renumbers everyone
-- cleanly, and it fixes the biggest-movers list and the homepage modules at
-- the same time, because all three read the same rankings table.
--
-- ONLY THE 'admin' ROLE. member / investor / advertiser / consultant are all
-- real people who may legitimately take part, so they stay.
--
-- CARRYING THE DEFINITIONS FORWARD. This codebase has been bitten three times
-- by redefining a SQL function and silently dropping what a later migration
-- added to it (see award_badge, 091 -> 093 -> 099 -> 100). Both functions
-- below are copied from their LATEST definition and changed in exactly one
-- way each — the admin filter:
--
--   recalculate_ranking        latest = 075_rankings_homepage.sql
--   recalculate_period_ranking latest = 084_leaderboard_periods.sql
--
-- recalculate_all_rankings and get_leaderboard are deliberately NOT touched:
-- once an admin never enters the rankings table, the read side needs no change.

-- ---------------------------------------------------------------------------
-- 1. Lifetime boards (overall / recognition / contribution / momentum)
-- ---------------------------------------------------------------------------
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
    WHERE COALESCE(u.role, 'member') <> 'admin'
    ON CONFLICT (user_id, ranking_type, period_type, period_value) DO UPDATE SET
      rank_position = EXCLUDED.rank_position,
      score_value   = EXCLUDED.score_value,
      -- The outer COALESCE is a fix, not a copy. The inner one only applies
      -- when ranking_history HAS a row; with no history at all the scalar
      -- subquery returns NULL, and rank_movement is NOT NULL, so the update
      -- fails outright. Unreachable today because recalculate_all_rankings()
      -- snapshots history immediately before calling this — but it means
      -- calling recalculate_ranking() on its own crashes, which is a trap for
      -- whoever does that next. Zero is the honest value: no history means no
      -- known movement.
      rank_movement = COALESCE((
        SELECT COALESCE(rh.rank_position, EXCLUDED.rank_position) - EXCLUDED.rank_position
          FROM ranking_history rh
         WHERE rh.user_id = rankings.user_id AND rh.ranking_type = p_ranking_type
         ORDER BY rh.snapshot_at DESC LIMIT 1
      ), 0),
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
    WHERE COALESCE(u.role, 'member') <> 'admin'
    ON CONFLICT (user_id, ranking_type, period_type, period_value) DO UPDATE SET
      rank_position = EXCLUDED.rank_position,
      score_value   = EXCLUDED.score_value,
      -- The outer COALESCE is a fix, not a copy. The inner one only applies
      -- when ranking_history HAS a row; with no history at all the scalar
      -- subquery returns NULL, and rank_movement is NOT NULL, so the update
      -- fails outright. Unreachable today because recalculate_all_rankings()
      -- snapshots history immediately before calling this — but it means
      -- calling recalculate_ranking() on its own crashes, which is a trap for
      -- whoever does that next. Zero is the honest value: no history means no
      -- known movement.
      rank_movement = COALESCE((
        SELECT COALESCE(rh.rank_position, EXCLUDED.rank_position) - EXCLUDED.rank_position
          FROM ranking_history rh
         WHERE rh.user_id = rankings.user_id AND rh.ranking_type = p_ranking_type
         ORDER BY rh.snapshot_at DESC LIMIT 1
      ), 0),
      calculated_at = now();
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- 2. Weekly / monthly boards
-- ---------------------------------------------------------------------------
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
    -- Added here: this function had no users join at all, so the admin
    -- filter needs one.
    JOIN users u ON u.id = pp.user_id
   WHERE pp.is_reversed = FALSE AND pp.earned_at >= v_start
     AND COALESCE(u.role, 'member') <> 'admin'
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

-- ---------------------------------------------------------------------------
-- 3. Clear out the admin rows already on the board, then renumber.
--
-- The functions above stop admins being added; they do not remove the rows
-- that are already there. The recompute is what closes the gap left behind,
-- so the board reads 1, 2, 3 rather than starting at 2.
--
-- SELF-DISARMING. migrate.js re-runs every .sql on every deploy, and a bare
-- recalculate_all_rankings() here would rebuild every board on every push for
-- no reason. This only does the work when an admin is actually on the board.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_admin_rows INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_admin_rows
    FROM rankings r JOIN users u ON u.id = r.user_id
   WHERE COALESCE(u.role, 'member') = 'admin';

  IF v_admin_rows > 0 THEN
    DELETE FROM rankings r USING users u
     WHERE u.id = r.user_id AND COALESCE(u.role, 'member') = 'admin';

    DELETE FROM ranking_history rh USING users u
     WHERE u.id = rh.user_id AND COALESCE(u.role, 'member') = 'admin';

    PERFORM recalculate_all_rankings();
    RAISE NOTICE 'Removed % admin ranking row(s) and renumbered the boards.', v_admin_rows;
  END IF;
END;
$$;
