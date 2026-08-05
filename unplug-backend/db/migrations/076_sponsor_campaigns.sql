-- Participation Engine — Stage E: sponsor/brand campaigns.
--
-- Deliberately a SEPARATE system from the existing `ad_slots` (the
-- "Advertise Here" banner rotation) — confirmed with the site owner.
-- ad_slots is a simple rotating banner at a fixed placement. This is for
-- a bigger kind of deal: a brand sponsoring a mission, a ranking, or a
-- moment on the homepage ("Presented by Brand X"), with its own
-- reporting (impressions/clicks/reach) that a banner slot doesn't track.
-- Nothing here touches or reads from ad_slots.

CREATE TABLE IF NOT EXISTS sponsorships (
  id               SERIAL PRIMARY KEY,
  sponsor_name     VARCHAR(160) NOT NULL,
  sponsor_logo_url TEXT,
  sponsor_url      TEXT,
  contact_name     VARCHAR(160),
  contact_email    VARCHAR(255),
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sponsor_campaigns (
  id              SERIAL PRIMARY KEY,
  sponsorship_id  INTEGER NOT NULL REFERENCES sponsorships(id),
  campaign_type   VARCHAR(20) NOT NULL
    CHECK (campaign_type IN ('daily_mission', 'rising_star', 'ranking', 'challenge', 'achievement', 'homepage')),
  campaign_label  VARCHAR(200) NOT NULL, -- e.g. "Presented by Brand X"
  placement_code  VARCHAR(40) NOT NULL,  -- e.g. 'homepage_todays_person', 'daily_mission'
  starts_at       DATE NOT NULL,
  ends_at         DATE NOT NULL,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  config          JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at >= starts_at)
);
CREATE INDEX IF NOT EXISTS idx_sponsor_campaigns_active ON sponsor_campaigns(is_active, starts_at, ends_at);
CREATE INDEX IF NOT EXISTS idx_sponsor_campaigns_placement ON sponsor_campaigns(placement_code, is_active);

CREATE TABLE IF NOT EXISTS sponsor_analytics (
  id                 SERIAL PRIMARY KEY,
  campaign_id        INTEGER NOT NULL REFERENCES sponsor_campaigns(id) ON DELETE CASCADE,
  snapshot_date      DATE NOT NULL DEFAULT CURRENT_DATE,
  impressions        INTEGER NOT NULL DEFAULT 0,
  clicks             INTEGER NOT NULL DEFAULT 0,
  missions_triggered INTEGER NOT NULL DEFAULT 0,
  profile_views      INTEGER NOT NULL DEFAULT 0,
  UNIQUE (campaign_id, snapshot_date)
);

-- =============================================================
-- Track one event against today's row for a campaign, creating it if
-- this is the first event of the day. Called from wherever a sponsored
-- placement is actually shown/clicked once Stage F wires up the routes.
-- =============================================================
CREATE OR REPLACE FUNCTION track_sponsor_impression(p_campaign_id INTEGER, p_event_type TEXT)
RETURNS VOID AS $$
DECLARE
  v_column TEXT;
BEGIN
  v_column := CASE p_event_type
    WHEN 'impression' THEN 'impressions'
    WHEN 'click'       THEN 'clicks'
    WHEN 'mission'      THEN 'missions_triggered'
    WHEN 'profile_view' THEN 'profile_views'
    ELSE NULL
  END;
  IF v_column IS NULL THEN
    RAISE EXCEPTION 'Unknown sponsor event type: %', p_event_type;
  END IF;

  INSERT INTO sponsor_analytics (campaign_id, snapshot_date) VALUES (p_campaign_id, CURRENT_DATE)
  ON CONFLICT (campaign_id, snapshot_date) DO NOTHING;

  EXECUTE format('UPDATE sponsor_analytics SET %I = %I + 1 WHERE campaign_id = $1 AND snapshot_date = $2', v_column, v_column)
    USING p_campaign_id, CURRENT_DATE;
END;
$$ LANGUAGE plpgsql;

-- =============================================================
-- The currently-active campaign for a placement, if any — the query
-- Stage F's routes use to decide whether to show "Presented by ...".
-- If more than one campaign is active for the same placement at once,
-- the most recently created one wins (admin's job to not overlap them).
-- =============================================================
CREATE OR REPLACE FUNCTION get_active_sponsor_campaign(p_placement_code TEXT)
RETURNS TABLE (
  campaign_id    INTEGER,
  campaign_label VARCHAR,
  sponsor_name   VARCHAR,
  sponsor_logo_url TEXT,
  sponsor_url    TEXT
) AS $$
  SELECT sc.id, sc.campaign_label, sp.sponsor_name, sp.sponsor_logo_url, sp.sponsor_url
    FROM sponsor_campaigns sc
    JOIN sponsorships sp ON sp.id = sc.sponsorship_id
   WHERE sc.placement_code = p_placement_code
     AND sc.is_active = TRUE AND sp.is_active = TRUE
     AND sc.starts_at <= CURRENT_DATE AND sc.ends_at >= CURRENT_DATE
   ORDER BY sc.created_at DESC
   LIMIT 1;
$$ LANGUAGE SQL STABLE;

-- =============================================================
-- Admin reporting: totals + rate for one campaign's whole run so far.
-- =============================================================
CREATE OR REPLACE FUNCTION get_sponsor_campaign_report(p_campaign_id INTEGER)
RETURNS TABLE (
  campaign_label        VARCHAR,
  sponsor_name          VARCHAR,
  starts_at             DATE,
  ends_at                DATE,
  days_active            INTEGER,
  days_remaining          INTEGER,
  total_impressions      BIGINT,
  total_clicks           BIGINT,
  total_missions          BIGINT,
  total_profile_views     BIGINT,
  click_rate              NUMERIC
) AS $$
  SELECT
    sc.campaign_label, sp.sponsor_name, sc.starts_at, sc.ends_at,
    GREATEST((CURRENT_DATE - sc.starts_at)::INTEGER, 0),
    GREATEST((sc.ends_at - CURRENT_DATE)::INTEGER, 0),
    COALESCE(SUM(sa.impressions), 0),
    COALESCE(SUM(sa.clicks), 0),
    COALESCE(SUM(sa.missions_triggered), 0),
    COALESCE(SUM(sa.profile_views), 0),
    CASE WHEN COALESCE(SUM(sa.impressions), 0) > 0
      THEN ROUND(COALESCE(SUM(sa.clicks), 0)::NUMERIC / SUM(sa.impressions) * 100, 2)
      ELSE 0 END
  FROM sponsor_campaigns sc
  JOIN sponsorships sp ON sp.id = sc.sponsorship_id
  LEFT JOIN sponsor_analytics sa ON sa.campaign_id = sc.id
  WHERE sc.id = p_campaign_id
  GROUP BY sc.id, sc.campaign_label, sp.sponsor_name, sc.starts_at, sc.ends_at;
$$ LANGUAGE SQL STABLE;
