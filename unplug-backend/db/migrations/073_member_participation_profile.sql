-- Participation Engine — Stage B: the personal participation profile +
-- member-to-member referrals.
--
-- This is deliberately NOT the same thing as the existing Directory
-- `profiles` table. Directory profiles are a paid service listing
-- (bio, category, contact details) — a business/personal offering shown
-- to the public. `member_participation_profiles` is purely internal
-- gamification bookkeeping (a referral code, participation-visibility
-- prefs) that every user gets automatically, whether or not they've ever
-- created a Directory listing. Confirmed with the site owner as two
-- unrelated concepts before building this.
--
-- Likewise `member_referrals` (invite-a-friend, points-based) is
-- deliberately separate from the existing sales-consultant referral
-- columns on `payments` (referral_source/sales_consultant_id), which
-- track commission attribution for a *paid* signup brought in by a
-- consultant — a different business relationship entirely, just an
-- unlucky shared word.

-- =============================================================
-- 1. MEMBER PARTICIPATION PROFILE
-- One row per user, created lazily (see ensure_member_participation_profile
-- below) rather than via a signup trigger, so it works uniformly for
-- users who already existed before this feature shipped and users who
-- sign up after.
-- =============================================================
CREATE TABLE IF NOT EXISTS member_participation_profiles (
  user_id              INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  referral_code        VARCHAR(20) NOT NULL UNIQUE,
  show_on_leaderboard  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_member_participation_referral_code ON member_participation_profiles(referral_code);

DROP TRIGGER IF EXISTS trg_member_participation_profiles_updated_at ON member_participation_profiles;
CREATE TRIGGER trg_member_participation_profiles_updated_at
  BEFORE UPDATE ON member_participation_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================
-- 2. MEMBER REFERRALS
-- A member invites a friend using their referral_code; this tracks that
-- friend's journey from registering through to becoming a genuinely
-- active member, and pays the referrer points at each real milestone.
-- =============================================================
CREATE TABLE IF NOT EXISTS member_referrals (
  id                  SERIAL PRIMARY KEY,
  referrer_user_id    INTEGER NOT NULL REFERENCES users(id),
  referred_user_id    INTEGER REFERENCES users(id),
  referral_code       VARCHAR(20) NOT NULL,
  status              VARCHAR(20) NOT NULL DEFAULT 'registered'
    CHECK (status IN ('registered', 'qualified')),
  registered_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  qualified_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (referrer_user_id, referred_user_id)
);
CREATE INDEX IF NOT EXISTS idx_member_referrals_referrer ON member_referrals(referrer_user_id);
CREATE INDEX IF NOT EXISTS idx_member_referrals_referred ON member_referrals(referred_user_id);

DROP TRIGGER IF EXISTS trg_member_referrals_updated_at ON member_referrals;
CREATE TRIGGER trg_member_referrals_updated_at
  BEFORE UPDATE ON member_referrals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================
-- 3. GENERATE A UNIQUE REFERRAL CODE
-- 'UNPLUG-' + 6 random uppercase alphanumeric characters, retried on
-- collision. Not tied to a display name (unlike the uploaded spec) —
-- this project's `users` table has no name field; Directory `profiles`
-- has one, but not every user has a Directory profile.
-- =============================================================
CREATE OR REPLACE FUNCTION generate_member_referral_code()
RETURNS VARCHAR AS $$
DECLARE
  candidate VARCHAR(20);
  attempt   INTEGER := 0;
BEGIN
  LOOP
    candidate := 'UNPLUG-' || UPPER(SUBSTRING(MD5(random()::TEXT || clock_timestamp()::TEXT) FROM 1 FOR 6));
    attempt := attempt + 1;
    EXIT WHEN attempt > 30 OR NOT EXISTS (
      SELECT 1 FROM member_participation_profiles WHERE referral_code = candidate
    );
  END LOOP;
  RETURN candidate;
END;
$$ LANGUAGE plpgsql;

-- =============================================================
-- 4. ENSURE A PROFILE EXISTS
-- Called at the top of any participation-related request (dashboard
-- load, referral processing, etc.) — idempotent, safe to call on every
-- request. Returns the (possibly newly-created) row.
-- =============================================================
CREATE OR REPLACE FUNCTION ensure_member_participation_profile(p_user_id INTEGER)
RETURNS member_participation_profiles AS $$
DECLARE
  v_row member_participation_profiles%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM member_participation_profiles WHERE user_id = p_user_id;
  IF FOUND THEN
    RETURN v_row;
  END IF;

  INSERT INTO member_participation_profiles (user_id, referral_code)
  VALUES (p_user_id, generate_member_referral_code())
  ON CONFLICT (user_id) DO NOTHING
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    -- Lost a race with a concurrent call for the same user — the other
    -- call's row now exists, so just read it back.
    SELECT * INTO v_row FROM member_participation_profiles WHERE user_id = p_user_id;
  END IF;

  RETURN v_row;
END;
$$ LANGUAGE plpgsql;

-- =============================================================
-- 5. PROCESS A MEMBER REFERRAL EVENT
-- 'registered' creates the referral record when a new user signs up
-- with someone else's code. 'qualified' is fired by a later stage (once
-- the referred member has genuinely engaged — e.g. their first
-- qualified active month) and pays the larger reward. Stage progression
-- only moves forward: a referral cannot regress or double-fire a stage.
-- =============================================================
CREATE OR REPLACE FUNCTION process_member_referral(
  p_referral_code TEXT,
  p_event_type    TEXT,
  p_new_user_id   INTEGER DEFAULT NULL
)
RETURNS TABLE (
  success        BOOLEAN,
  referrer_id    INTEGER,
  points_earned  INTEGER,
  blocked_reason TEXT
) AS $$
DECLARE
  v_referrer_id  INTEGER;
  v_referral     member_referrals%ROWTYPE;
  v_action_code  TEXT;
  v_tx           RECORD;
BEGIN
  SELECT user_id INTO v_referrer_id FROM member_participation_profiles WHERE referral_code = p_referral_code;
  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, NULL::INTEGER, 0, 'referral_code_not_found';
    RETURN;
  END IF;

  IF v_referrer_id = p_new_user_id THEN
    RETURN QUERY SELECT FALSE, v_referrer_id, 0, 'self_referral';
    RETURN;
  END IF;

  IF p_event_type = 'registered' THEN
    IF p_new_user_id IS NULL THEN
      RETURN QUERY SELECT FALSE, v_referrer_id, 0, 'new_user_id_required';
      RETURN;
    END IF;

    BEGIN
      INSERT INTO member_referrals (referrer_user_id, referred_user_id, referral_code, status, registered_at)
      VALUES (v_referrer_id, p_new_user_id, p_referral_code, 'registered', now())
      RETURNING * INTO v_referral;
    EXCEPTION WHEN unique_violation THEN
      RETURN QUERY SELECT FALSE, v_referrer_id, 0, 'referral_already_recorded';
      RETURN;
    END;

    v_action_code := 'member_referral_registered';
  ELSIF p_event_type = 'qualified' THEN
    SELECT * INTO v_referral FROM member_referrals
     WHERE referrer_user_id = v_referrer_id AND referred_user_id = p_new_user_id;
    IF NOT FOUND THEN
      RETURN QUERY SELECT FALSE, v_referrer_id, 0, 'referral_not_found';
      RETURN;
    END IF;
    IF v_referral.status = 'qualified' THEN
      RETURN QUERY SELECT FALSE, v_referrer_id, 0, 'already_qualified';
      RETURN;
    END IF;

    UPDATE member_referrals SET status = 'qualified', qualified_at = now() WHERE id = v_referral.id;
    v_action_code := 'member_referral_qualified';
  ELSE
    RETURN QUERY SELECT FALSE, v_referrer_id, 0, 'unknown_event_type';
    RETURN;
  END IF;

  SELECT ap.success, ap.tx_id, ap.points_earned INTO v_tx FROM award_points(
    p_user_id       := v_referrer_id,
    p_action_code   := v_action_code,
    p_content_type  := 'member_referral',
    p_content_id    := v_referral.id,
    p_source        := 'system',
    p_notes         := 'Referral ' || p_event_type || ': ' || p_referral_code
  ) AS ap;

  IF p_event_type = 'qualified' THEN
    INSERT INTO notifications (user_id, type, title, body, link_url)
    VALUES (
      v_referrer_id, 'referral',
      '🤝 Your referral became an active member!',
      'Someone you invited has become an active Unplug member. You earned ' || COALESCE(v_tx.points_earned, 0) || ' points.',
      '/unplug-member-dashboard.html'
    );
  END IF;

  RETURN QUERY SELECT COALESCE(v_tx.success, FALSE), v_referrer_id, COALESCE(v_tx.points_earned, 0), NULL::TEXT;
END;
$$ LANGUAGE plpgsql;

-- =============================================================
-- 6. SEED — the two referral point actions.
-- =============================================================
INSERT INTO participation_actions (code, label, category_code, base_points, unique_per_object, counts_for_active_month, counts_as_meaningful, counts_as_contribution)
VALUES
  ('member_referral_registered', 'A referral registered', 'community', 20, TRUE, TRUE, TRUE, FALSE),
  ('member_referral_qualified',  'A referral became an active member', 'community', 75, TRUE, TRUE, TRUE, TRUE)
ON CONFLICT (code) DO NOTHING;
