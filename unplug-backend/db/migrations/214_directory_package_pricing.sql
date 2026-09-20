-- Batch D: one authoritative source for Directory package pricing.
--
-- This migration deliberately changes NO PRICE. The six seeded values are the
-- exact values the production backend charged immediately before this change:
--   Individual: Basic 150 / Pro 280 / Premium 400
--   Business:   Basic 500 / Pro 700 / Premium 1000
--
-- Directory pricing has two identity dimensions (profile type + tier), so it
-- does not belong in service_packages, whose identity is service + duration.
-- Keeping the shapes honest avoids fake "duration" values and confusing admin
-- data later.
CREATE TABLE IF NOT EXISTS directory_package_prices (
  id            SERIAL PRIMARY KEY,
  profile_type  VARCHAR(20) NOT NULL
                CHECK (profile_type IN ('individual', 'business')),
  tier          VARCHAR(20) NOT NULL
                CHECK (tier IN ('basic', 'pro', 'premium')),
  price         NUMERIC(10,2) NOT NULL CHECK (price >= 0),
  active        BOOLEAN NOT NULL DEFAULT true,
  display_order INTEGER NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (profile_type, tier)
);

CREATE INDEX IF NOT EXISTS idx_directory_package_prices_active
  ON directory_package_prices (profile_type, active, display_order, tier);

-- Migrations are re-run on deploy. DO NOTHING is essential: once an admin
-- changes a price, a later deploy must never silently put the seed value back.
INSERT INTO directory_package_prices
  (profile_type, tier, price, active, display_order)
VALUES
  ('individual', 'basic',   150.00, true, 1),
  ('individual', 'pro',     280.00, true, 2),
  ('individual', 'premium', 400.00, true, 3),
  ('business',   'basic',   500.00, true, 1),
  ('business',   'pro',     700.00, true, 2),
  ('business',   'premium',1000.00, true, 3)
ON CONFLICT (profile_type, tier) DO NOTHING;
