-- Admin-managed pricing for the duration-based services (highlight packages and
-- advertising banners), so prices can change without a code deploy.
--
-- The prices previously lived only in constants in routes/payments.js. Those
-- constants stay as the fallback: if a row is missing here the server still
-- charges the old, known price rather than failing or charging zero.
CREATE TABLE IF NOT EXISTS service_packages (
  id            SERIAL PRIMARY KEY,
  service_key   VARCHAR(40) NOT NULL,   -- highlight_article | highlight_directory | ad_banner
  duration_days SMALLINT NOT NULL,
  name          VARCHAR(120) NOT NULL,
  description   TEXT,
  price         NUMERIC(10,2) NOT NULL CHECK (price >= 0),
  active        BOOLEAN NOT NULL DEFAULT true,
  display_order INTEGER NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (service_key, duration_days)
);
CREATE INDEX IF NOT EXISTS idx_service_packages_key ON service_packages (service_key, active, display_order);

-- Seed with today's live prices so nothing changes the moment this ships.
--
-- ON CONFLICT DO NOTHING is essential, not cosmetic: db/migrate.js re-runs every
-- migration on every deploy, so an upsert here would silently revert an admin's
-- price change on the next deploy. Existing rows are left exactly as the admin
-- set them.
INSERT INTO service_packages (service_key, duration_days, name, description, price, display_order) VALUES
  ('highlight_article',    7, '7-Day Article Highlight',  'Feature your article more prominently across the site for 7 days.',  150.00, 1),
  ('highlight_article',   14, '14-Day Article Highlight', 'Feature your article more prominently across the site for 14 days.', 250.00, 2),
  ('highlight_article',   21, '21-Day Article Highlight', 'Feature your article more prominently across the site for 21 days.', 300.00, 3),
  ('highlight_article',   28, '28-Day Article Highlight', 'Feature your article more prominently across the site for 28 days.', 450.00, 4),
  ('highlight_directory',  7, '7-Day Profile Highlight',  'Feature your Directory profile on the homepage for 7 days.',  100.00, 1),
  ('highlight_directory', 14, '14-Day Profile Highlight', 'Feature your Directory profile on the homepage for 14 days.', 150.00, 2),
  ('highlight_directory', 21, '21-Day Profile Highlight', 'Feature your Directory profile on the homepage for 21 days.', 200.00, 3),
  ('highlight_directory', 28, '28-Day Profile Highlight', 'Feature your Directory profile on the homepage for 28 days.', 250.00, 4),
  ('ad_banner',            7, '7-Day Advertising Banner',  'Your banner rotates in the chosen placement for 7 days.',   300.00, 1),
  ('ad_banner',           14, '14-Day Advertising Banner', 'Your banner rotates in the chosen placement for 14 days.',  550.00, 2),
  ('ad_banner',           28, '28-Day Advertising Banner', 'Your banner rotates in the chosen placement for 28 days.', 1000.00, 3)
ON CONFLICT (service_key, duration_days) DO NOTHING;
