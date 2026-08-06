-- Participation Engine — Stage M: Discovery Engine.
--
-- Surfaces genuinely under-exposed things — not a rotation/points system
-- like the earlier stages, just three read-only queries against data that
-- already exists: articles with real content but few page_views, active
-- members nobody has recognised yet, and business listings still low on
-- the status ladder. No new tables — this stage is entirely functions
-- over 002_profiles.sql / 017_activity_analytics_inquiries.sql /
-- 071-081's existing schema.

-- =============================================================
-- 1. UNDER-VIEWED ARTICLES — approved articles from the last 60 days,
-- ranked by fewest page_views relative to their age (views per day since
-- publish), ascending — so a 2-day-old article with 3 views ranks above
-- a 55-day-old article with 3 views (the older one has simply had more
-- time to be found and still wasn't, which is a weaker discovery
-- candidate than something brand new nobody's SEEN yet). Requires at
-- least one day since publish to avoid dividing by zero and to give an
-- article at least a full day before judging its visibility.
-- =============================================================
CREATE OR REPLACE FUNCTION get_discovery_articles(p_limit INTEGER DEFAULT 6)
RETURNS TABLE (id INTEGER, title VARCHAR, category VARCHAR, banner_image_url TEXT, published_at TIMESTAMPTZ, views BIGINT) AS $$
  SELECT a.id, a.title, c.name, a.banner_image_url, a.published_at,
         COALESCE(pv.n, 0) AS views
    FROM articles a
    LEFT JOIN categories c ON c.id = a.category_id
    LEFT JOIN (
      SELECT SPLIT_PART(page_path, '-', 2)::INTEGER AS article_id, COUNT(*) AS n
        FROM page_views
       WHERE page_path ~ '^article-[0-9]+$'
       GROUP BY SPLIT_PART(page_path, '-', 2)::INTEGER
    ) pv ON pv.article_id = a.id
   WHERE a.status = 'approved'
     AND a.published_at IS NOT NULL
     AND a.published_at >= now() - INTERVAL '60 days'
     AND a.published_at <= now() - INTERVAL '1 day'
   ORDER BY (COALESCE(pv.n, 0) / GREATEST(EXTRACT(DAY FROM now() - a.published_at), 1)) ASC, a.published_at DESC
   LIMIT p_limit;
$$ LANGUAGE SQL STABLE;

-- =============================================================
-- 2. OVERLOOKED MEMBERS — genuinely participating (earned points in the
-- last 14 days) but under-recognised (fewest recognition_receive
-- transactions all-time). Excludes members with zero activity so this
-- never surfaces a dormant account nobody should be nudged to notice.
--
-- process_recognition() (Stage C) calls award_points() for
-- recognition_receive with p_user_id = the RECEIVER and never sets
-- p_content_owner (it stays NULL) — so "who received it" lives in
-- participation_points.user_id here, not content_owner_id. Confirmed
-- against 074_recognition_achievements_missions.sql before writing this,
-- since content_owner_id would look like the natural column and is wrong.
-- =============================================================
CREATE OR REPLACE FUNCTION get_discovery_members(p_limit INTEGER DEFAULT 6)
RETURNS TABLE (user_id INTEGER, display_name TEXT, status_label VARCHAR, status_emoji VARCHAR, recognitions_received BIGINT) AS $$
  SELECT u.id, COALESCE(dp.display_name, SPLIT_PART(u.email, '@', 1)),
         sl.label, sl.emoji,
         COALESCE(rc.n, 0) AS recognitions_received
    FROM users u
    JOIN (
      SELECT DISTINCT user_id FROM participation_points
       WHERE is_reversed = FALSE AND earned_at >= now() - INTERVAL '14 days'
    ) active ON active.user_id = u.id
    LEFT JOIN profiles dp ON dp.user_id = u.id AND dp.status = 'approved'
    LEFT JOIN member_status_history msh ON msh.user_id = u.id AND msh.is_active_status = TRUE
    LEFT JOIN member_status_levels sl ON sl.code = msh.status_code
    LEFT JOIN (
      SELECT user_id, COUNT(*) AS n FROM participation_points
       WHERE action_code = 'recognition_receive' AND is_reversed = FALSE
       GROUP BY user_id
    ) rc ON rc.user_id = u.id
   WHERE u.role = 'member'
   ORDER BY COALESCE(rc.n, 0) ASC, u.id ASC
   LIMIT p_limit;
$$ LANGUAGE SQL STABLE;

-- =============================================================
-- 3. RISING BUSINESSES — approved business listings still on the bottom
-- two rungs of the business status ladder (new_listing/rising_business,
-- rank <= 2) — the ones a visitor would otherwise have to already know
-- to find. Newest-approved first within that group.
-- =============================================================
CREATE OR REPLACE FUNCTION get_discovery_businesses(p_limit INTEGER DEFAULT 6)
RETURNS TABLE (id INTEGER, slug VARCHAR, display_name VARCHAR, category VARCHAR, status_label VARCHAR, status_emoji VARCHAR) AS $$
  SELECT p.id, p.slug, p.display_name, c.name,
         COALESCE(sl.label, 'New Listing'), COALESCE(sl.emoji, '🆕')
    FROM profiles p
    LEFT JOIN categories c ON c.id = p.category_id
    LEFT JOIN business_status_history bsh ON bsh.profile_id = p.id AND bsh.is_active_status = TRUE
    LEFT JOIN business_status_levels sl ON sl.code = bsh.status_code
   WHERE p.type = 'business' AND p.status = 'approved'
     AND COALESCE(sl.rank_order, 1) <= 2
   ORDER BY p.created_at DESC
   LIMIT p_limit;
$$ LANGUAGE SQL STABLE;
