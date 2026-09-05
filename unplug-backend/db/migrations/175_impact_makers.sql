-- Impact Makers — a digital recognition gallery of people, brands, sponsors,
-- partners and organisations contributing to the Unplug ecosystem, fully
-- admin-curated (add/edit/delete/reorder/feature/status).
--
-- Deliberately its OWN category system, not the shared `categories` table
-- Directory/News already use (that table's `type` CHECK is hardcoded to
-- ('directory','news') and has never been widened) -- confirmed with the
-- requester before building this: Impact Makers should stay fully decoupled
-- from Directory, not share its taxonomy.
CREATE TABLE IF NOT EXISTS impact_maker_categories (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(80) NOT NULL UNIQUE,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO impact_maker_categories (name, display_order) VALUES
  ('Business', 1), ('Community', 2), ('Education', 3), ('Entertainment', 4),
  ('Fashion', 5), ('Food', 6), ('Lifestyle', 7), ('Sport', 8), ('Technology', 9),
  ('Travel', 10), ('Arts & Culture', 11), ('Entrepreneurship', 12),
  ('Social Impact', 13), ('Media', 14), ('Other', 15)
ON CONFLICT (name) DO NOTHING;

-- Social links are plain columns here, not the shared `social_links` table
-- (002_profiles.sql) -- that table's CHECK only allows 6 platforms (no
-- YouTube) and is shared with Directory/Investors. Matches the requester's
-- own suggested schema exactly, and keeps this feature fully self-contained.
--
-- `slug` exists from day one so an individual profile page is addable later
-- with no schema change, even though no such page is built yet -- nothing
-- writes or reads it until that future page exists.
CREATE TABLE IF NOT EXISTS impact_makers (
  id                SERIAL PRIMARY KEY,
  first_name        VARCHAR(80),
  surname           VARCHAR(80),
  display_name      VARCHAR(160) NOT NULL,
  photo_url         TEXT,
  category_id       INTEGER REFERENCES impact_maker_categories(id) ON DELETE SET NULL,
  impact_maker_type VARCHAR(30) NOT NULL DEFAULT 'individual'
    CHECK (impact_maker_type IN (
      'individual', 'business', 'sponsor', 'partner', 'organisation',
      'changemaker', 'entrepreneur', 'creative', 'community_leader',
      'professional', 'artist', 'founder', 'other'
    )),
  bio               TEXT,
  instagram_url     VARCHAR(500),
  facebook_url      VARCHAR(500),
  linkedin_url      VARCHAR(500),
  tiktok_url        VARCHAR(500),
  youtube_url       VARCHAR(500),
  x_url             VARCHAR(500),
  website_url       VARCHAR(500),
  featured          BOOLEAN NOT NULL DEFAULT false,
  display_order     INTEGER NOT NULL DEFAULT 0,
  status            VARCHAR(20) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published', 'archived')),
  slug              VARCHAR(160) UNIQUE,
  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Matches the public query's exact shape: published rows, featured first,
-- then admin-chosen order.
CREATE INDEX IF NOT EXISTS idx_impact_makers_public
  ON impact_makers (status, featured DESC, display_order, id);
