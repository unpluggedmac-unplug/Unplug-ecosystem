-- Tables for Pierre's three new admin features (activity log, site
-- analytics, inquiries). The routes for these were added and deployed, but
-- deploying code never touches the database — migrations are a separate
-- manual step (`npm run migrate`) — so every request against these tables
-- failed with "relation does not exist" (the Activity Log 500 seen on
-- 2026-07-10). Column names/types match exactly what the routes use.

-- src/routes/activityLog.js — one row per admin action (who did what, when).
CREATE TABLE IF NOT EXISTS admin_activity_log (
  id            SERIAL PRIMARY KEY,
  admin_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action        VARCHAR(120) NOT NULL,
  details       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_activity_log_created ON admin_activity_log (created_at DESC);

-- src/routes/inquiries.js — the public Contact form + admin inbox.
CREATE TABLE IF NOT EXISTS inquiries (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(160) NOT NULL,
  email       VARCHAR(255) NOT NULL,
  subject     VARCHAR(255),
  message     TEXT NOT NULL,
  status      VARCHAR(20) NOT NULL DEFAULT 'new'
              CHECK (status IN ('new', 'read', 'replied')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inquiries_created ON inquiries (created_at DESC);

-- src/routes/analytics.js — one row per page view. NOTE: the summary
-- queries filter and group on viewed_at (not created_at), and the INSERT
-- never supplies it, so the DEFAULT here is what actually populates it.
CREATE TABLE IF NOT EXISTS page_views (
  id          SERIAL PRIMARY KEY,
  page_path   VARCHAR(500) NOT NULL,
  session_id  VARCHAR(120),
  viewed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_page_views_viewed ON page_views (viewed_at);
CREATE INDEX IF NOT EXISTS idx_page_views_path ON page_views (page_path);
