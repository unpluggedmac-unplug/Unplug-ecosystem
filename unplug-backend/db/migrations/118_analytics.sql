-- FIRST-PARTY ANALYTICS.
--
-- page_views (017) stored a path, a session id and a timestamp. That answers
-- "which pages are popular" and nothing else — not where readers came from,
-- not what they read on, not whether they had been here before, and not
-- whether any of it ever turned into money.
--
-- It is left exactly as it is. It holds real history, other code reads it, and
-- there is nothing to gain from rewriting it. These tables sit alongside.
--
-- TWO tables, because the questions are different shapes:
--   analytics_sessions — one row per visit. Entry and exit page, how long,
--     how many pages, and WHERE THE VISIT CAME FROM. Attribution belongs to a
--     visit, not to each page inside it: a reader who arrives from Instagram
--     and then opens four articles came from Instagram once, not four times.
--   analytics_events — one row per thing that happened, including conversions.
--
-- Aggregating from events alone would mean re-deriving each visit's source on
-- every report, over a table that grows fastest. Sessions make the common
-- questions cheap and keep attribution in one place.
--
-- NO IP ADDRESSES ARE STORED, ANYWHERE. An IP is personal information under
-- POPIA. The country is resolved from the edge header at request time and the
-- address itself is never written down.

CREATE TABLE IF NOT EXISTS analytics_sessions (
  session_id     VARCHAR(120) PRIMARY KEY,
  -- Persists across visits in the browser, so a second visit is recognisable
  -- as the same person WITHOUT knowing who they are. Random, first-party, and
  -- only ever minted after the visitor accepts the consent bar.
  visitor_id     VARCHAR(120) NOT NULL,
  is_returning   BOOLEAN NOT NULL DEFAULT FALSE,

  -- Where the visit came from. `source` is the classified channel shown in
  -- reports (Instagram, Organic Search, Direct...); referrer_host keeps the
  -- raw fact behind it so a wrong classification can be spotted and fixed
  -- rather than silently believed.
  source         VARCHAR(60),
  medium         VARCHAR(60),
  campaign       VARCHAR(160),
  referrer_host  VARCHAR(255),
  landing_path   VARCHAR(500),

  device_type    VARCHAR(20),
  browser        VARCHAR(40),
  os             VARCHAR(40),
  country        CHAR(2),

  -- Set once a visitor signs in, which is what lets revenue be traced back to
  -- the visit that brought them. Nullable for ever: most visits are anonymous.
  user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,

  entry_path     VARCHAR(500),
  exit_path      VARCHAR(500),
  page_count     INTEGER NOT NULL DEFAULT 0,
  event_count    INTEGER NOT NULL DEFAULT 0,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_an_sessions_started ON analytics_sessions (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_an_sessions_visitor ON analytics_sessions (visitor_id);
CREATE INDEX IF NOT EXISTS idx_an_sessions_source ON analytics_sessions (source);
CREATE INDEX IF NOT EXISTS idx_an_sessions_user ON analytics_sessions (user_id) WHERE user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS analytics_events (
  id           BIGSERIAL PRIMARY KEY,
  session_id   VARCHAR(120),
  visitor_id   VARCHAR(120),
  -- 'page_view', or a conversion name such as 'signup', 'article_submitted',
  -- 'newsletter_signup', 'enquiry', 'payment'. Deliberately free text rather
  -- than a CHECK constraint: a new thing worth counting must never require a
  -- migration, and this table is written to on every page load.
  event_name   VARCHAR(60) NOT NULL,
  page_path    VARCHAR(500),

  -- What the event was about, when it was about something: an article id, a
  -- profile id, a payment id. Loose on purpose — a foreign key here would mean
  -- deleting an article silently deleting the record that it was ever read.
  entity_type  VARCHAR(40),
  entity_id    INTEGER,

  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- Money, in cents, for conversion events. Cents so no rounding can creep in.
  value_cents  INTEGER,

  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_an_events_occurred ON analytics_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_an_events_name ON analytics_events (event_name, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_an_events_session ON analytics_events (session_id);
CREATE INDEX IF NOT EXISTS idx_an_events_path ON analytics_events (page_path) WHERE event_name = 'page_view';
CREATE INDEX IF NOT EXISTS idx_an_events_entity ON analytics_events (entity_type, entity_id);

-- The Google Analytics 4 measurement ID. Empty means GA is simply not loaded,
-- which is the correct state until someone pastes a real ID in — a half-wired
-- tag that fires at no property is worse than no tag, because it looks like it
-- is working.
INSERT INTO settings (key, value) VALUES ('ga4_measurement_id', '')
ON CONFLICT (key) DO NOTHING;
