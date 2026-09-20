-- MY UNPLUG — per-field public/private controls + member-owned custom interests.
--
-- Privacy rules approved 2026-09-20:
--   * @username and display_name are public only when the whole profile is published.
--   * avatar/about/location/interests/skills/purposes/tags are independently switchable.
--   * NEW profiles default every optional field to PRIVATE.
--   * Existing PUBLISHED profiles keep the visibility they had before this feature.
--     Existing unpublished profiles default private.
--   * Custom interests belong only to one member; they never become global taxonomy rows.

ALTER TABLE my_unplug_profiles
  ADD COLUMN IF NOT EXISTS field_visibility JSONB;

-- Backfill only legacy rows. Because the column is added nullable first, a re-run
-- cannot overwrite choices a member has made since this migration first ran.
UPDATE my_unplug_profiles
   SET field_visibility = CASE
     WHEN is_published THEN
       '{"avatar":true,"about":true,"country":true,"province":true,"city":true,"interests":true,"skills":true,"purposes":true,"tags":true}'::jsonb
     ELSE
       '{"avatar":false,"about":false,"country":false,"province":false,"city":false,"interests":false,"skills":false,"purposes":false,"tags":false}'::jsonb
   END
 WHERE field_visibility IS NULL;

ALTER TABLE my_unplug_profiles
  ALTER COLUMN field_visibility SET DEFAULT
    '{"avatar":false,"about":false,"country":false,"province":false,"city":false,"interests":false,"skills":false,"purposes":false,"tags":false}'::jsonb,
  ALTER COLUMN field_visibility SET NOT NULL;

ALTER TABLE my_unplug_profiles DROP CONSTRAINT IF EXISTS my_unplug_field_visibility_object;
ALTER TABLE my_unplug_profiles ADD CONSTRAINT my_unplug_field_visibility_object
  CHECK (jsonb_typeof(field_visibility) = 'object');

CREATE TABLE IF NOT EXISTS mu_profile_custom_interests (
  id               BIGSERIAL PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES my_unplug_profiles(user_id) ON DELETE CASCADE,
  label            VARCHAR(60) NOT NULL,
  normalized_label VARCHAR(60) NOT NULL,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mu_custom_interest_label_nonblank CHECK (char_length(trim(label)) BETWEEN 2 AND 60),
  CONSTRAINT mu_custom_interest_normalized_nonblank CHECK (char_length(trim(normalized_label)) BETWEEN 2 AND 60),
  UNIQUE (user_id, normalized_label)
);

CREATE INDEX IF NOT EXISTS idx_mu_profile_custom_interests_user
  ON mu_profile_custom_interests (user_id, sort_order, id);

-- Public member search must never match words that live only in a private bio.
-- Keep the old idx_my_unplug_fts from migration 150 for backwards compatibility;
-- this privacy-aware expression is what the live member search uses from now on.
CREATE INDEX IF NOT EXISTS idx_my_unplug_public_fts
  ON my_unplug_profiles USING gin (
    to_tsvector('english',
      coalesce(display_name, '') || ' ' ||
      coalesce(username, '') || ' ' ||
      CASE WHEN COALESCE(field_visibility->>'about', 'false') = 'true'
           THEN coalesce(about_me, '') ELSE '' END)
  );

-- The homepage featured-member row is public, so whole-profile publishing and
-- field-level privacy apply there too. Same return shape as migration 130.
DROP FUNCTION IF EXISTS get_featured_members(INTEGER);

CREATE OR REPLACE FUNCTION get_featured_members(p_limit INTEGER DEFAULT 5)
RETURNS TABLE (
  kind          TEXT,
  ref           TEXT,
  display_name  TEXT,
  image_url     TEXT,
  tagline       TEXT,
  status_label  VARCHAR,
  status_emoji  VARCHAR,
  activity      BIGINT,
  is_pinned     BOOLEAN
) AS $$
  WITH recent AS (
    SELECT pp.user_id, SUM(pp.total_points)::BIGINT AS score
      FROM participation_points pp
     WHERE pp.is_reversed = FALSE
       AND pp.earned_at >= now() - INTERVAL '30 days'
     GROUP BY pp.user_id
  )
  SELECT 'member'::TEXT,
         mp.username::TEXT,
         mp.display_name::TEXT,
         CASE WHEN COALESCE(mp.field_visibility->>'avatar', 'false') = 'true'
              THEN mp.avatar_url::TEXT ELSE NULL::TEXT END,
         CASE WHEN COALESCE(mp.field_visibility->>'country', 'false') = 'true'
              THEN COALESCE(NULLIF(mp.country, ''), 'Member')::TEXT
              ELSE 'Member'::TEXT END,
         sl.label, sl.emoji,
         COALESCE(r.score, 0) AS activity,
         (o.state = 'pinned') AS is_pinned
    FROM my_unplug_profiles mp
    JOIN users u ON u.id = mp.user_id
    LEFT JOIN recent r ON r.user_id = mp.user_id
    LEFT JOIN featured_member_overrides o ON o.user_id = mp.user_id
    LEFT JOIN member_status_history msh ON msh.user_id = mp.user_id AND msh.is_active_status = TRUE
    LEFT JOIN member_status_levels sl ON sl.code = msh.status_code
   WHERE mp.is_published = TRUE
     AND COALESCE(u.role, 'member') <> 'admin'
     AND (o.state IS DISTINCT FROM 'removed')
   ORDER BY (o.state = 'pinned') DESC NULLS LAST,
            COALESCE(r.score, 0) DESC,
            mp.display_name ASC
   LIMIT GREATEST(p_limit, 1);
$$ LANGUAGE SQL STABLE;
