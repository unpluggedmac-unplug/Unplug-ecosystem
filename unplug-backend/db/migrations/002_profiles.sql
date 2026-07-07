-- Unplug Ecosystem — Phase 3, Step 2: Profiles + Directory
-- Depends on 001_users.sql having already run.

CREATE TABLE IF NOT EXISTS categories (
  id    SERIAL PRIMARY KEY,
  name  VARCHAR(60) NOT NULL,
  type  VARCHAR(20) NOT NULL CHECK (type IN ('directory', 'news')),
  UNIQUE (name, type)
);

CREATE TABLE IF NOT EXISTS profiles (
  id                SERIAL PRIMARY KEY,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type              VARCHAR(20) NOT NULL DEFAULT 'individual'
                    CHECK (type IN ('individual', 'business')),
  category_id       INTEGER REFERENCES categories(id),
  package_tier      VARCHAR(20) NOT NULL CHECK (package_tier IN ('basic', 'pro', 'premium')),
  slug              VARCHAR(160) NOT NULL UNIQUE,
  display_name      VARCHAR(160) NOT NULL,
  bio               TEXT,
  achievements      TEXT,
  career            TEXT,
  quote             TEXT,
  contact_email     VARCHAR(255),
  contact_phone     VARCHAR(30),
  contact_website   VARCHAR(255),
  status            VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One profile per user for now (a person has a single Directory listing).
-- If multi-profile-per-account (e.g. personal + business) is needed later,
-- drop this constraint — the schema already supports it structurally.
CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_user_id ON profiles (user_id);
CREATE INDEX IF NOT EXISTS idx_profiles_status ON profiles (status);
CREATE INDEX IF NOT EXISTS idx_profiles_category ON profiles (category_id);
CREATE INDEX IF NOT EXISTS idx_profiles_slug ON profiles (slug);

CREATE TABLE IF NOT EXISTS profile_upgrades (
  id          SERIAL PRIMARY KEY,
  profile_id  INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  from_tier   VARCHAR(20) NOT NULL,
  to_tier     VARCHAR(20) NOT NULL,
  fee_paid    NUMERIC(10,2) NOT NULL DEFAULT 250.00,
  paid_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Polymorphic: serves Directory profiles, Investor profiles, and general
-- Gallery submissions from the same two tables (per Backend Spec Section 2).
CREATE TABLE IF NOT EXISTS social_links (
  id          SERIAL PRIMARY KEY,
  owner_type  VARCHAR(20) NOT NULL CHECK (owner_type IN ('profile', 'investor')),
  owner_id    INTEGER NOT NULL,
  platform    VARCHAR(10) NOT NULL CHECK (platform IN ('ig', 'fb', 'tt', 'li', 'wa', 'tw')),
  url         VARCHAR(500) NOT NULL,
  UNIQUE (owner_type, owner_id, platform)
);
CREATE INDEX IF NOT EXISTS idx_social_links_owner ON social_links (owner_type, owner_id);

CREATE TABLE IF NOT EXISTS gallery_images (
  id            SERIAL PRIMARY KEY,
  owner_type    VARCHAR(20) NOT NULL CHECK (owner_type IN ('profile', 'investor', 'general')),
  owner_id      INTEGER,
  image_url     VARCHAR(500) NOT NULL,
  caption       VARCHAR(255),
  supplied_by   VARCHAR(160),
  status        VARCHAR(20) NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gallery_owner ON gallery_images (owner_type, owner_id);
CREATE INDEX IF NOT EXISTS idx_gallery_status ON gallery_images (status);

-- Seed the 27 Directory categories confirmed earlier.
INSERT INTO categories (name, type) VALUES
  ('Activists', 'directory'), ('Actors', 'directory'), ('Athletes', 'directory'),
  ('Authors', 'directory'), ('Bakers', 'directory'), ('Bloggers', 'directory'),
  ('Chefs', 'directory'), ('Coaches', 'directory'), ('Comedians', 'directory'),
  ('Crafters', 'directory'), ('Creations', 'directory'), ('Dancers', 'directory'),
  ('Designers', 'directory'), ('Entrepreneurs', 'directory'), ('Explorers', 'directory'),
  ('Fitness', 'directory'), ('Founders', 'directory'), ('Hairstylists', 'directory'),
  ('Influencers', 'directory'), ('Instructors', 'directory'), ('Makeup Artists', 'directory'),
  ('Models', 'directory'), ('Motivational Speakers', 'directory'), ('Musicians', 'directory'),
  ('Performers', 'directory'), ('Photographers', 'directory'), ('TikTokkers', 'directory')
ON CONFLICT (name, type) DO NOTHING;
