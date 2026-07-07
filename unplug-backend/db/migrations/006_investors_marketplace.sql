-- Unplug Ecosystem — Phase 3, Step 6: Investors, Marketplace, Highlights
-- Depends on 001_users.sql through 005_competitions.sql having already run.

CREATE TABLE IF NOT EXISTS investors (
  id                SERIAL PRIMARY KEY,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name              VARCHAR(160) NOT NULL,
  about             TEXT,
  contact_email     VARCHAR(255),
  contact_phone     VARCHAR(30),
  contact_website   VARCHAR(255),
  status            VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_investors_user_id ON investors (user_id);
CREATE INDEX IF NOT EXISTS idx_investors_status ON investors (status);

-- Reuses the polymorphic social_links / gallery_images tables from
-- 002_profiles.sql — owner_type = 'investor' — no new tables needed for
-- an investor's social channels or collaboration gallery.

CREATE TABLE IF NOT EXISTS advertisers (
  id                SERIAL PRIMARY KEY,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_name     VARCHAR(160) NOT NULL,
  contact_email     VARCHAR(255),
  contact_phone     VARCHAR(30),
  contact_website   VARCHAR(255),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_advertisers_user_id ON advertisers (user_id);

CREATE TABLE IF NOT EXISTS marketplace_listings (
  id                SERIAL PRIMARY KEY,
  advertiser_id     INTEGER NOT NULL REFERENCES advertisers(id) ON DELETE CASCADE,
  poster_image_url  VARCHAR(500) NOT NULL,
  headline          VARCHAR(255),
  duration_days     SMALLINT NOT NULL CHECK (duration_days IN (7, 14, 21, 28)),
  status            VARCHAR(20) NOT NULL DEFAULT 'awaiting_payment'
                    CHECK (status IN ('awaiting_payment', 'pending', 'approved', 'rejected')),
  active_from       DATE,
  active_to         DATE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_listings_status ON marketplace_listings (status);
CREATE INDEX IF NOT EXISTS idx_listings_active ON marketplace_listings (active_from, active_to);

-- Highlights & Promotions pricing, exactly as locked in the Master Blueprint.
-- Only 'article' and 'directory' — a "banner" highlight is the same concept
-- as a marketplace_listings duration/price, so that's handled through
-- marketplace_listings.duration_days instead of duplicating it here.
CREATE TABLE IF NOT EXISTS highlights (
  id            SERIAL PRIMARY KEY,
  target_type   VARCHAR(20) NOT NULL CHECK (target_type IN ('article', 'directory')),
  target_id     INTEGER NOT NULL,
  duration_days SMALLINT NOT NULL CHECK (duration_days IN (7, 14, 21, 28)),
  status        VARCHAR(20) NOT NULL DEFAULT 'awaiting_payment'
                CHECK (status IN ('awaiting_payment', 'pending', 'approved', 'rejected')),
  start_date    DATE,
  end_date      DATE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_highlights_status ON highlights (status);
CREATE INDEX IF NOT EXISTS idx_highlights_target ON highlights (target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_highlights_active ON highlights (start_date, end_date);
