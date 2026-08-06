-- Members, Profile Social Interaction & Community System — remaining admin
-- panel gaps from the brief's item 11: suspend users (distinct from the
-- existing owns-content-guarded delete), configurable notification types,
-- and configurable public-analytics visibility. Delete Interactions and
-- moderate comments/reviews already exist (comments.js/reviews.js admin
-- routes, and DELETE /comments/:id already lets an admin remove any
-- comment) — this migration only adds what was genuinely missing.

-- =============================================================
-- 1. SUSPEND USERS — distinct from DELETE /admin/users/:id, which is
-- blocked outright for any account that owns published content. A
-- suspension needs no such guard: it's reversible and doesn't touch what
-- the account owns, just whether it can sign in. Checked at the two
-- sign-in entry points (password login, magic-link consume) rather than
-- on every authenticated request — the same "takes effect on next
-- token" model this codebase already uses for role changes (see the
-- "cannot change your own role" comment in admin.js), so an existing 7-day
-- token isn't instantly revoked, but a suspended account cannot start (or
-- refresh) a new session.
-- =============================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_suspended BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_reason TEXT;

-- =============================================================
-- 2. CONFIGURABLE NOTIFICATION TYPES — the three notification types this
-- session's Members/Community System work actually introduced or
-- centralised: profile_interaction (like/dislike/save/comment/review, via
-- notifyProfileOwner in interactions.js), follow (member_follows), and
-- badge (award_badge). The older gamification engine's notification types
-- (status_change, mission, streak_tier, passport, achievement,
-- recognition, referral, featured — Stages H-Q) predate this brief and
-- were not flagged as needing admin configurability, so they are left
-- alone rather than re-declaring ~10 unrelated functions speculatively.
-- Reuses the generic settings table + GET/PATCH /admin/settings routes,
-- same as 090_community_settings.sql.
-- =============================================================
INSERT INTO settings (key, value) VALUES
  ('notify_profile_interaction_enabled', 'true'),
  ('notify_follow_enabled',              'true'),
  ('notify_badge_enabled',               'true'),
  ('public_analytics_visible',           'true')
ON CONFLICT (key) DO NOTHING;

-- follow_member / unfollow_member re-declared in full (087) with a
-- notify_follow_enabled guard around the notification insert only — the
-- follow relationship itself, the points award, and the idempotency are
-- all unchanged.
CREATE OR REPLACE FUNCTION follow_member(p_follower_id INTEGER, p_followed_id INTEGER)
RETURNS BOOLEAN AS $$
DECLARE
  v_follower_name TEXT;
  v_inserted BOOLEAN := FALSE;
BEGIN
  IF p_follower_id = p_followed_id THEN
    RETURN FALSE;
  END IF;

  INSERT INTO member_follows (follower_user_id, followed_user_id)
  VALUES (p_follower_id, p_followed_id)
  ON CONFLICT (follower_user_id, followed_user_id) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF NOT v_inserted THEN
    RETURN FALSE;
  END IF;

  PERFORM award_points(p_user_id := p_followed_id, p_action_code := 'follow_received',
    p_content_type := 'profile', p_content_id := p_follower_id, p_source := 'system',
    p_notes := 'Gained a follower');

  IF COALESCE((SELECT value FROM settings WHERE key = 'notify_follow_enabled'), 'true') <> 'false' THEN
    SELECT COALESCE(pr.display_name, SPLIT_PART(u.email, '@', 1)) INTO v_follower_name
      FROM users u LEFT JOIN profiles pr ON pr.user_id = u.id
     WHERE u.id = p_follower_id;

    INSERT INTO notifications (user_id, type, title, body, link_url)
    VALUES (p_followed_id, 'follow', '👋 New follower', v_follower_name || ' started following you.', '/unplug-member-dashboard.html');
  END IF;

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

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

  IF COALESCE((SELECT value FROM settings WHERE key = 'notify_follow_enabled'), 'true') <> 'false' THEN
    SELECT COALESCE(pr.display_name, SPLIT_PART(u.email, '@', 1)) INTO v_follower_name
      FROM users u LEFT JOIN profiles pr ON pr.user_id = u.id
     WHERE u.id = p_follower_id;

    INSERT INTO notifications (user_id, type, title, body, link_url)
    VALUES (p_followed_id, 'follow', 'Follower update', v_follower_name || ' unfollowed you.', '/unplug-member-dashboard.html');
  END IF;

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

-- award_badge re-declared in full (091) with the same notify_badge_enabled
-- guard — the badge is still awarded either way, only the notification is
-- gated.
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

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;
