-- An admin may award ANY badge, including one that is currently disabled.
--
-- award_badge used to look the badge up with `AND is_enabled = TRUE` and
-- return FALSE otherwise. That made a disabled badge silently unawardable:
-- the admin panel lists every badge type, so the option was offered, the
-- award appeared to be accepted, and the only feedback was the same "already
-- has this badge" message used for a genuine duplicate. Two quite different
-- outcomes were indistinguishable.
--
-- is_enabled still controls what the PUBLIC list of obtainable badges shows
-- (GET /badges) — it just no longer blocks a deliberate admin grant. The
-- route now 404s on a badge code that does not exist, so a FALSE return from
-- this function unambiguously means "they already have it".
--
-- Everything else is carried forward verbatim from 099_badge_month_year.sql,
-- which itself carries forward the notify kill switch and follower fan-out
-- added by 093. Redefining this function means restating all of it; the
-- tests in badgePeriodAndTop10Editor.test.js guard each part.

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
  -- No is_enabled filter: see the header above.
  SELECT * INTO v_badge FROM badges WHERE code = p_badge_code;
  IF NOT FOUND THEN RETURN FALSE; END IF;

  v_month := COALESCE(p_award_month, v_badge.award_month);
  v_year  := COALESCE(p_award_year,  v_badge.award_year);
  IF v_month IS NULL OR v_year IS NULL THEN
    v_month := NULL;
    v_year  := NULL;
  END IF;

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
