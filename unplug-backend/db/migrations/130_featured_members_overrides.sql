-- "Unplug Members worth checking out" — Unplug members only, and the admin
-- gets the final say over who appears.
--
-- TWO CHANGES FROM 129.
--
-- 1. MY UNPLUG PROFILES ONLY. 129 also featured businesses with a Directory
--    listing. The owner's instruction is that this row is Unplug MEMBERS, so
--    the business branch is gone. The consequence is real and worth knowing:
--    the row is only as long as the number of members who have made a profile,
--    and fills itself in as more of them do. That is the intended behaviour,
--    not a fault to work around.
--
-- 2. THE ADMIN CAN PIN AND REMOVE. The row still fills itself, so it needs no
--    upkeep, but an admin decision always wins over the ranking:
--
--      pinned   always appears, above the automatic picks
--      removed  never appears, however active they are
--
--    Stored as overrides rather than as a hand-built list, so the automatic
--    row keeps working and only the exceptions are recorded. Removing someone
--    is reversible — deleting the row restores them to the ranking.
--
-- Admins remain excluded, as in 126.

CREATE TABLE IF NOT EXISTS featured_member_overrides (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  state      VARCHAR(10) NOT NULL CHECK (state IN ('pinned', 'removed')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per member: a person is pinned or removed, never both, which the
-- primary key already guarantees.
CREATE INDEX IF NOT EXISTS featured_member_overrides_state_idx
  ON featured_member_overrides (state);

-- DROPPED FIRST, not just replaced. 129 declared this function returning eight
-- columns; this one adds is_pinned, and CREATE OR REPLACE cannot change a
-- function's return type — Postgres raises 42P13 "cannot change return type of
-- existing function" and the whole migration fails. Since migrate.js runs
-- every .sql on every deploy, that would have failed the deploy itself, not
-- just this file.
--
-- Safe to drop: it is a read-only function with no dependent views, and the
-- CREATE immediately below puts it straight back.
DROP FUNCTION IF EXISTS get_featured_members(INTEGER);

CREATE OR REPLACE FUNCTION get_featured_members(p_limit INTEGER DEFAULT 5)
RETURNS TABLE (
  kind          TEXT,     -- always 'member' now; kept so the page needs no change
  ref           TEXT,     -- the My Unplug username
  display_name  TEXT,
  image_url     TEXT,
  tagline       TEXT,
  status_label  VARCHAR,
  status_emoji  VARCHAR,
  activity      BIGINT,
  is_pinned     BOOLEAN
) AS $$
  WITH recent AS (
    -- Activity in the last 30 days. Reversed points are excluded so a
    -- cancelled action cannot buy a place on the homepage.
    SELECT pp.user_id, SUM(pp.total_points)::BIGINT AS score
      FROM participation_points pp
     WHERE pp.is_reversed = FALSE
       AND pp.earned_at >= now() - INTERVAL '30 days'
     GROUP BY pp.user_id
  )
  SELECT 'member'::TEXT,
         mp.username::TEXT,
         mp.display_name::TEXT,
         mp.avatar_url::TEXT,
         COALESCE(NULLIF(mp.country, ''), 'Member')::TEXT,
         sl.label, sl.emoji,
         COALESCE(r.score, 0) AS activity,
         (o.state = 'pinned') AS is_pinned
    FROM my_unplug_profiles mp
    JOIN users u ON u.id = mp.user_id
    LEFT JOIN recent r ON r.user_id = mp.user_id
    LEFT JOIN featured_member_overrides o ON o.user_id = mp.user_id
    LEFT JOIN member_status_history msh ON msh.user_id = mp.user_id AND msh.is_active_status = TRUE
    LEFT JOIN member_status_levels sl ON sl.code = msh.status_code
   WHERE COALESCE(u.role, 'member') <> 'admin'
     -- An admin removal wins over any amount of activity.
     AND (o.state IS DISTINCT FROM 'removed')
   -- Pinned first, then the most active. Ties broken by name so the row is
   -- stable between page loads instead of reshuffling at random.
   ORDER BY (o.state = 'pinned') DESC NULLS LAST,
            COALESCE(r.score, 0) DESC,
            mp.display_name ASC
   LIMIT GREATEST(p_limit, 1);
$$ LANGUAGE SQL STABLE;
