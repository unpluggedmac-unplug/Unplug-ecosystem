-- Month and year on badges, in both places they can meaningfully live:
--   - on the badge TYPE, for a badge that IS a period ("August 2026 Top 10");
--   - on each AWARD, so a generic badge type can be given for a period and
--     the same member can hold it for several different months.
--
-- The second is the reason the uniqueness rule has to change. user_badges
-- carried UNIQUE (user_id, badge_code), which is exactly right while a badge
-- is a one-off, and exactly wrong the moment a "Top 10" badge should be
-- awardable again next month.

ALTER TABLE badges       ADD COLUMN IF NOT EXISTS award_month SMALLINT;
ALTER TABLE badges       ADD COLUMN IF NOT EXISTS award_year  SMALLINT;
ALTER TABLE user_badges  ADD COLUMN IF NOT EXISTS award_month SMALLINT;
ALTER TABLE user_badges  ADD COLUMN IF NOT EXISTS award_year  SMALLINT;

-- Month/year are a pair: a month without a year cannot identify a period, and
-- a lone year would silently behave as "undated" under the indexes below.
-- Named constraints so re-running this file is a no-op rather than an error.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'badges_award_period_check') THEN
    ALTER TABLE badges ADD CONSTRAINT badges_award_period_check
      CHECK ((award_month IS NULL) = (award_year IS NULL)
             AND (award_month IS NULL OR award_month BETWEEN 1 AND 12)
             AND (award_year  IS NULL OR award_year  BETWEEN 2000 AND 2100));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_badges_award_period_check') THEN
    ALTER TABLE user_badges ADD CONSTRAINT user_badges_award_period_check
      CHECK ((award_month IS NULL) = (award_year IS NULL)
             AND (award_month IS NULL OR award_month BETWEEN 1 AND 12)
             AND (award_year  IS NULL OR award_year  BETWEEN 2000 AND 2100));
  END IF;
END $$;

-- Replace the flat UNIQUE (user_id, badge_code) with two partial indexes.
--
-- A plain 4-column UNIQUE would NOT work here: Postgres treats NULLs as
-- distinct in a unique index, so every undated award would collide with
-- nothing and a member could be given the same one-off badge without limit.
-- Splitting on "is this award dated?" keeps the original guarantee intact for
-- undated badges while allowing one per month for dated ones.
ALTER TABLE user_badges DROP CONSTRAINT IF EXISTS user_badges_user_id_badge_code_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_badges_once
  ON user_badges (user_id, badge_code)
  WHERE award_month IS NULL AND award_year IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_badges_per_period
  ON user_badges (user_id, badge_code, award_year, award_month)
  WHERE award_month IS NOT NULL AND award_year IS NOT NULL;

-- award_badge has to be replaced along with the indexes, not after them: its
-- old body says ON CONFLICT (user_id, badge_code), which names a constraint
-- that no longer exists, and Postgres rejects such a statement outright
-- rather than ignoring it. Leaving it would break every award.
--
-- Dropped rather than CREATE OR REPLACE'd because the signature grows two
-- arguments; replacing in place would leave the old 4-argument version behind
-- as an overload, and a 4-argument call would then be ambiguous.
DROP FUNCTION IF EXISTS award_badge(INTEGER, TEXT, INTEGER, TEXT);

CREATE OR REPLACE FUNCTION award_badge(
  p_user_id INTEGER,
  p_badge_code TEXT,
  p_awarded_by INTEGER,
  p_reason TEXT DEFAULT NULL,
  p_award_month SMALLINT DEFAULT NULL,
  p_award_year SMALLINT DEFAULT NULL
)
RETURNS BOOLEAN AS $$
DECLARE
  v_badge badges%ROWTYPE;
  v_inserted BOOLEAN;
  v_month SMALLINT;
  v_year SMALLINT;
  v_period TEXT := '';
BEGIN
  SELECT * INTO v_badge FROM badges WHERE code = p_badge_code AND is_enabled = TRUE;
  IF NOT FOUND THEN RETURN FALSE; END IF;

  -- An explicit period wins; otherwise inherit the badge type's own, so a
  -- badge that IS "August 2026" does not have to have that retyped per award.
  v_month := COALESCE(p_award_month, v_badge.award_month);
  v_year  := COALESCE(p_award_year,  v_badge.award_year);
  -- Half a period is not a period. Falling back to undated is safer than
  -- letting the CHECK reject the award outright.
  IF v_month IS NULL OR v_year IS NULL THEN
    v_month := NULL;
    v_year  := NULL;
  END IF;

  -- Two inserts because the applicable index differs, and ON CONFLICT must
  -- name an index that actually covers the row being inserted.
  IF v_month IS NULL THEN
    INSERT INTO user_badges (user_id, badge_code, awarded_by, reason)
    VALUES (p_user_id, p_badge_code, p_awarded_by, p_reason)
    ON CONFLICT (user_id, badge_code)
      WHERE award_month IS NULL AND award_year IS NULL
    DO NOTHING;
  ELSE
    INSERT INTO user_badges (user_id, badge_code, awarded_by, reason, award_month, award_year)
    VALUES (p_user_id, p_badge_code, p_awarded_by, p_reason, v_month, v_year)
    ON CONFLICT (user_id, badge_code, award_year, award_month)
      WHERE award_month IS NOT NULL AND award_year IS NOT NULL
    DO NOTHING;
  END IF;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF NOT v_inserted THEN RETURN FALSE; END IF;

  IF v_month IS NOT NULL THEN
    v_period := ' (' || to_char(make_date(v_year::int, v_month::int, 1), 'FMMonth YYYY') || ')';
  END IF;

  -- The two behaviours below are NOT new here — they were added by
  -- 093_following_activity_feed.sql and must be carried forward, because this
  -- file redefines the whole function and would otherwise silently drop them.
  -- The badge notification respects its kill switch, and the award still
  -- reaches the recipient's followers. Caught by the fan-out test in
  -- followingActivityFeed.test.js.
  IF COALESCE((SELECT value FROM settings WHERE key = 'notify_badge_enabled'), 'true') <> 'false' THEN
    INSERT INTO notifications (user_id, type, title, body, link_url)
    VALUES (p_user_id, 'badge', v_badge.emoji || ' Badge earned: ' || v_badge.label || v_period,
      COALESCE(p_reason, v_badge.description), '/unplug-member-dashboard.html');
  END IF;

  PERFORM fan_out_following_activity(
    p_user_id, v_badge.emoji, 'earned the "' || v_badge.label || '" badge' || v_period);

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;
