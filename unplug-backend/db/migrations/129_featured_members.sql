-- "Unplug Members worth checking out" — the homepage card row.
--
-- Replaces the old "Active, under the radar" list, which was plain text rows
-- and, for individuals, not even clickable. Three decisions from the owner
-- shape this:
--
--   MOST ACTIVE, not least. The old list ordered by FEWEST recognitions, which
--   is what "under the radar" meant. This ranks by participation earned in the
--   last 30 days, so the row is the people currently doing things.
--
--   INDIVIDUALS AND BUSINESSES IN ONE ROW, ranked against each other, rather
--   than the two separate lists that used to sit side by side.
--
--   ONLY PEOPLE WITH A PROFILE. A card is a picture and a link; somebody with
--   neither renders a grey box that goes nowhere. An individual qualifies via
--   a My Unplug profile (?p=myunplug&u=username); a business via an approved
--   Directory listing (?p=profile&slug=). Anyone with neither is skipped, so
--   every card on the homepage opens something.
--
-- ADMINS ARE EXCLUDED, for the same reason they were taken off the
-- leaderboard in 126: running the site is not taking part in it.
--
-- The count is a parameter rather than a constant so an admin can move it from
-- 5 to 10 without a deploy — see the featured_members_count setting below.

CREATE OR REPLACE FUNCTION get_featured_members(p_limit INTEGER DEFAULT 5)
RETURNS TABLE (
  kind          TEXT,     -- 'member' | 'business'
  ref           TEXT,     -- username for a member, slug for a business
  display_name  TEXT,
  image_url     TEXT,
  tagline       TEXT,     -- category for a business, location for a member
  status_label  VARCHAR,
  status_emoji  VARCHAR,
  activity      BIGINT
) AS $$
  WITH recent AS (
    -- One activity score per person, from the last 30 days. Reversed points
    -- are excluded so a cancelled action cannot buy a place on the homepage.
    SELECT pp.user_id, SUM(pp.total_points)::BIGINT AS score
      FROM participation_points pp
     WHERE pp.is_reversed = FALSE
       AND pp.earned_at >= now() - INTERVAL '30 days'
     GROUP BY pp.user_id
  ),
  eligible AS (
    -- A business listing. Preferred over the individual card when somebody
    -- has both, because a Directory profile is the richer public page.
    SELECT 'business'::TEXT AS kind,
           p.slug::TEXT AS ref,
           p.display_name::TEXT AS display_name,
           p.feature_image_url::TEXT AS image_url,
           COALESCE(c.name, 'Directory')::TEXT AS tagline,
           u.id AS user_id
      FROM profiles p
      JOIN users u ON u.id = p.user_id
      LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.status = 'approved'
       AND p.slug IS NOT NULL
       AND COALESCE(u.role, 'member') <> 'admin'

    UNION ALL

    -- An individual with a My Unplug profile.
    SELECT 'member'::TEXT,
           mp.username::TEXT,
           mp.display_name::TEXT,
           mp.avatar_url::TEXT,
           COALESCE(NULLIF(mp.country, ''), 'Member')::TEXT,
           u.id
      FROM my_unplug_profiles mp
      JOIN users u ON u.id = mp.user_id
     WHERE COALESCE(u.role, 'member') <> 'admin'
       -- Skip the individual card when this person already appears as a
       -- business, so one person cannot occupy two of the five places.
       AND NOT EXISTS (
         SELECT 1 FROM profiles p2
          WHERE p2.user_id = mp.user_id AND p2.status = 'approved' AND p2.slug IS NOT NULL
       )
  )
  SELECT e.kind, e.ref, e.display_name, e.image_url, e.tagline,
         sl.label, sl.emoji,
         COALESCE(r.score, 0) AS activity
    FROM eligible e
    LEFT JOIN recent r ON r.user_id = e.user_id
    LEFT JOIN member_status_history msh ON msh.user_id = e.user_id AND msh.is_active_status = TRUE
    LEFT JOIN member_status_levels sl ON sl.code = msh.status_code
   -- Ties broken by name so the row is stable between page loads rather than
   -- reshuffling at random when several people have the same score.
   ORDER BY COALESCE(r.score, 0) DESC, e.display_name ASC
   LIMIT GREATEST(p_limit, 1);
$$ LANGUAGE SQL STABLE;

-- How many cards to show. Five now; the owner can make it ten later from the
-- admin without a deploy. ON CONFLICT DO NOTHING so a redeploy never resets a
-- number the admin has changed — the same rule as the service prices.
INSERT INTO settings (key, value) VALUES ('featured_members_count', '5')
ON CONFLICT (key) DO NOTHING;
