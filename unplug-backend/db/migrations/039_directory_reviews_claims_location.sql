-- Wave 3 groundwork for the directory: where a listing is, what people think
-- of it, and who owns it.

-- Location. Coordinates are nullable: most listings will only ever have a
-- town name, and the API fills in coordinates from a town lookup when they're
-- missing, so the map still works without anyone typing latitudes.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS city      VARCHAR(120);
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS province  VARCHAR(80);
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS latitude  NUMERIC(9,6);
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS longitude NUMERIC(9,6);

CREATE INDEX IF NOT EXISTS profiles_location_idx ON profiles (latitude, longitude);

-- Reviews. One review per member per listing (the unique constraint), so a
-- rating can be edited but not stacked. Moderated like comments: nothing is
-- public until an admin approves it.
CREATE TABLE IF NOT EXISTS profile_reviews (
  id          SERIAL PRIMARY KEY,
  profile_id  INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating      SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body        TEXT,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  UNIQUE (profile_id, user_id)
);

CREATE INDEX IF NOT EXISTS profile_reviews_public_idx
  ON profile_reviews (profile_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS profile_reviews_queue_idx
  ON profile_reviews (status, created_at);

-- Claims. A member asserts a listing is their business; an admin approves,
-- which transfers ownership. Kept as its own table (rather than just flipping
-- profiles.user_id) so there's an auditable record of who claimed what.
CREATE TABLE IF NOT EXISTS profile_claims (
  id          SERIAL PRIMARY KEY,
  profile_id  INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message     TEXT,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  UNIQUE (profile_id, user_id)
);

CREATE INDEX IF NOT EXISTS profile_claims_queue_idx
  ON profile_claims (status, created_at);
