-- Members, Profile Social Interaction & Community System — Phase 4:
-- Follow / Unfollow System.
--
-- Keyed on users.id, not profiles.id — profiles.user_id is one-per-user
-- (confirmed against 002_profiles.sql before designing this), and every
-- other system this needs to integrate with (participation_points,
-- notifications, trust_scores, member_status_history) is already keyed
-- on user_id. Following "a business" and following "an individual" are
-- the same relationship at this level; the profile UI just displays
-- whichever type that user's profile happens to be.

CREATE TABLE IF NOT EXISTS member_follows (
  id                SERIAL PRIMARY KEY,
  follower_user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followed_user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (follower_user_id, followed_user_id),
  CHECK (follower_user_id != followed_user_id)
);
CREATE INDEX IF NOT EXISTS idx_member_follows_follower ON member_follows(follower_user_id);
CREATE INDEX IF NOT EXISTS idx_member_follows_followed ON member_follows(followed_user_id);

-- =============================================================
-- FOLLOW — idempotent (following twice is a no-op, same as every other
-- "toggle" action in this engine), awards a small amount of points to
-- the person gained as a follower (Unplug Score integration, per the
-- brief's item 8), and notifies them.
-- =============================================================
CREATE OR REPLACE FUNCTION follow_member(p_follower_id INTEGER, p_followed_id INTEGER)
RETURNS BOOLEAN AS $$
DECLARE
  v_follower_name TEXT;
  v_inserted BOOLEAN := FALSE;
BEGIN
  IF p_follower_id = p_followed_id THEN
    RETURN FALSE; -- self-follow is a no-op, not an error — the CHECK
                   -- constraint would reject it anyway; this avoids the
                   -- caller having to catch a constraint-violation
  END IF;

  INSERT INTO member_follows (follower_user_id, followed_user_id)
  VALUES (p_follower_id, p_followed_id)
  ON CONFLICT (follower_user_id, followed_user_id) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF NOT v_inserted THEN
    RETURN FALSE; -- already following — nothing new happened
  END IF;

  PERFORM award_points(p_user_id := p_followed_id, p_action_code := 'follow_received',
    p_content_type := 'profile', p_content_id := p_follower_id, p_source := 'system',
    p_notes := 'Gained a follower');

  SELECT COALESCE(pr.display_name, SPLIT_PART(u.email, '@', 1)) INTO v_follower_name
    FROM users u LEFT JOIN profiles pr ON pr.user_id = u.id
   WHERE u.id = p_follower_id;

  INSERT INTO notifications (user_id, type, title, body, link_url)
  VALUES (p_followed_id, 'follow', '👋 New follower', v_follower_name || ' started following you.', '/unplug-member-dashboard.html');

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

-- =============================================================
-- UNFOLLOW — no points reversal (the brief never asks for one, and
-- reversing a gamification award on unfollow would let anyone farm
-- follow/unfollow cycles for a wash — actually a net negative for
-- points-farming since the award only happens on first-follow anyway,
-- but keeping it one-directional is simpler and matches how likes/saves
-- work elsewhere in this engine: no points are lost by withdrawing).
-- =============================================================
CREATE OR REPLACE FUNCTION unfollow_member(p_follower_id INTEGER, p_followed_id INTEGER)
RETURNS BOOLEAN AS $$
DECLARE
  v_deleted BOOLEAN;
  v_follower_name TEXT;
BEGIN
  DELETE FROM member_follows WHERE follower_user_id = p_follower_id AND followed_user_id = p_followed_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF NOT v_deleted THEN
    RETURN FALSE;
  END IF;

  SELECT COALESCE(pr.display_name, SPLIT_PART(u.email, '@', 1)) INTO v_follower_name
    FROM users u LEFT JOIN profiles pr ON pr.user_id = u.id
   WHERE u.id = p_follower_id;

  INSERT INTO notifications (user_id, type, title, body, link_url)
  VALUES (p_followed_id, 'follow', 'Follower update', v_follower_name || ' unfollowed you.', '/unplug-member-dashboard.html');

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION get_follow_counts(p_user_id INTEGER)
RETURNS TABLE (followers INTEGER, following INTEGER) AS $$
  SELECT
    (SELECT COUNT(*) FROM member_follows WHERE followed_user_id = p_user_id)::INTEGER,
    (SELECT COUNT(*) FROM member_follows WHERE follower_user_id = p_user_id)::INTEGER;
$$ LANGUAGE SQL STABLE;

-- =============================================================
-- SEED — follow_received joins the point-earning vocabulary. No daily
-- limit (gaining followers isn't something the followed member controls
-- the pace of), but a weekly cap and the same trust-score floor Stage O
-- put on the other social actions, consistent with treating
-- "an account gaining a lot of social signal very fast" as the same
-- risk shape regardless of which action produces it.
-- =============================================================
INSERT INTO participation_actions (code, label, category_code, base_points, weekly_limit, unique_per_object, counts_for_active_month, counts_as_meaningful, counts_as_contribution, min_trust_score)
VALUES ('follow_received', 'Gained a follower', 'community', 5, 100, TRUE, TRUE, TRUE, FALSE, 50)
ON CONFLICT (code) DO NOTHING;
