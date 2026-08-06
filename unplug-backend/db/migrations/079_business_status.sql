-- Participation Engine — Stage I: Business status ladder.
--
-- The member status ladder (Stage A, member_status_levels) is scored from
-- the point ledger — it doesn't fit businesses, which don't earn points,
-- they run listings. This is a parallel, independent ladder keyed to a
-- Directory profile (profiles.id where type = 'business'), scored off
-- metrics that already exist on that listing: approved reviews, average
-- rating, approved gallery images, and how long the listing has been live
-- (profiles.created_at, same "created_at as tenure" convention Stage A
-- uses for member join date). No new point type, no new ledger — this
-- reads existing tables, it doesn't compete with the member score.

-- =============================================================
-- 1. LEVELS + HISTORY — same shape as member_status_levels/history
-- (Stage A), with thresholds swapped for business-relevant metrics.
-- =============================================================
CREATE TABLE IF NOT EXISTS business_status_levels (
  id                        SERIAL PRIMARY KEY,
  code                      VARCHAR(30) NOT NULL UNIQUE,
  label                     VARCHAR(60) NOT NULL,
  emoji                     VARCHAR(10) NOT NULL,
  rank_order                INTEGER NOT NULL,
  min_reviews               INTEGER NOT NULL DEFAULT 0,
  min_avg_rating            NUMERIC(3,2) NOT NULL DEFAULT 0,
  min_gallery_images        INTEGER NOT NULL DEFAULT 0,
  min_days_listed           INTEGER NOT NULL DEFAULT 0,
  requires_admin_approval   BOOLEAN NOT NULL DEFAULT FALSE,
  is_hall_of_fame           BOOLEAN NOT NULL DEFAULT FALSE,
  description               TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS business_status_history (
  id                    SERIAL PRIMARY KEY,
  profile_id            INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  status_code           VARCHAR(30) NOT NULL REFERENCES business_status_levels(code),
  previous_status       VARCHAR(30) REFERENCES business_status_levels(code),
  achieved_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviews_at_time       INTEGER NOT NULL DEFAULT 0,
  avg_rating_at_time    NUMERIC(3,2) NOT NULL DEFAULT 0,
  gallery_at_time       INTEGER NOT NULL DEFAULT 0,
  days_listed_at_time   INTEGER NOT NULL DEFAULT 0,
  granted_by            INTEGER REFERENCES users(id),
  notes                 TEXT,
  is_active_status      BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS idx_business_status_history_profile ON business_status_history(profile_id);
CREATE INDEX IF NOT EXISTS idx_business_status_history_current ON business_status_history(profile_id, is_active_status);

DROP TRIGGER IF EXISTS trg_business_status_levels_updated_at ON business_status_levels;
CREATE TRIGGER trg_business_status_levels_updated_at BEFORE UPDATE ON business_status_levels FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================
-- 2. METRICS — read-only, computed from existing tables. Only approved
-- reviews/gallery images count, same "nothing counts until moderated"
-- rule the rest of the Directory already follows.
-- =============================================================
CREATE OR REPLACE FUNCTION get_business_metrics(p_profile_id INTEGER)
RETURNS TABLE (reviews_count INTEGER, avg_rating NUMERIC, gallery_count INTEGER, days_listed INTEGER) AS $$
  SELECT
    COALESCE((SELECT COUNT(*) FROM profile_reviews WHERE profile_id = p_profile_id AND status = 'approved'), 0)::INTEGER,
    COALESCE((SELECT ROUND(AVG(rating), 2) FROM profile_reviews WHERE profile_id = p_profile_id AND status = 'approved'), 0)::NUMERIC,
    COALESCE((SELECT COUNT(*) FROM gallery_images WHERE owner_type = 'profile' AND owner_id = p_profile_id AND status = 'approved'), 0)::INTEGER,
    COALESCE((SELECT EXTRACT(DAY FROM now() - created_at)::INTEGER FROM profiles WHERE id = p_profile_id), 0);
$$ LANGUAGE SQL STABLE;

CREATE OR REPLACE FUNCTION get_business_status_rank(p_profile_id INTEGER)
RETURNS INTEGER AS $$
  SELECT COALESCE(
    (SELECT sl.rank_order
       FROM business_status_history bsh
       JOIN business_status_levels sl ON sl.code = bsh.status_code
      WHERE bsh.profile_id = p_profile_id AND bsh.is_active_status = TRUE
      LIMIT 1),
    0
  );
$$ LANGUAGE SQL STABLE;

-- =============================================================
-- 3. CHECK AND UPDATE — same promote-one-tier-at-a-time pattern as
-- check_and_update_status() (Stage A). Hall-of-fame / admin-approval
-- tiers are excluded from auto-promotion, same reasoning as the member
-- ladder: the top tier is a manually-granted honour, not an algorithmic
-- outcome. A no-op (not an error) for non-business profiles, since the
-- callers (review/gallery approval) don't always know the profile's type
-- ahead of time.
-- =============================================================
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
  END IF;

  RETURN 'promoted_to_' || v_new_status.code;
END;
$$ LANGUAGE plpgsql;

-- Bulk sweep for tenure-based promotions (a listing can qualify purely by
-- getting older, with no review/gallery event to trigger a check) — run
-- from the scheduler, same "catch it even if nothing fired an event
-- today" reasoning as rotate_weekly_mission().
CREATE OR REPLACE FUNCTION sync_all_business_statuses()
RETURNS INTEGER AS $$
DECLARE
  v_profile RECORD;
  v_count INTEGER := 0;
BEGIN
  FOR v_profile IN SELECT id FROM profiles WHERE type = 'business' AND status = 'approved' LOOP
    IF check_and_update_business_status(v_profile.id) LIKE 'promoted_to_%' THEN
      v_count := v_count + 1;
    END IF;
  END LOOP;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql;

-- =============================================================
-- 4. SEED — five tiers. Rank 1 has all-zero thresholds so the very first
-- check_and_update_business_status() call after approval promotes a
-- listing into it immediately, same as 'explorer' does for members.
-- =============================================================
INSERT INTO business_status_levels (code, label, emoji, rank_order, min_reviews, min_avg_rating, min_gallery_images, min_days_listed, requires_admin_approval, is_hall_of_fame, description)
VALUES
  ('new_listing',         'New Listing',         '🆕', 1,  0, 0.00, 0,   0, FALSE, FALSE, 'A new Directory listing.'),
  ('rising_business',     'Rising Business',     '🌱', 2,  3, 3.50, 0,  14, FALSE, FALSE, 'Building an early reputation.'),
  ('trusted_business',    'Trusted Business',    '✅', 3, 10, 4.00, 3,  60, FALSE, FALSE, 'A consistently well-reviewed listing.'),
  ('community_favourite', 'Community Favourite', '⭐', 4, 25, 4.30, 5, 180, FALSE, FALSE, 'A standout listing the community keeps coming back to.'),
  ('business_hall_of_fame','Business Hall of Fame','🏆', 5, 50, 4.50, 8, 365, TRUE,  TRUE,  'The highest business honour on Unplug — admin-granted.')
ON CONFLICT (code) DO NOTHING;
