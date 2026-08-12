-- MY UNPLUG — the member's community identity ("who you are on Unplug").
--
-- DELIBERATELY SEPARATE FROM THE DIRECTORY. `profiles` (002_profiles.sql) is
-- the Directory: what you offer and where you can be found — services, a
-- contact email, a phone number, an address, a paid package tier, an admin
-- approval workflow. This table is none of those things. The only thing the
-- two share is users.id.
--
-- Concretely, that means:
--   * creating a My Unplug profile NEVER creates a Directory listing, and
--     vice versa — there is no trigger, no cascade, no FK between them;
--   * a member can have My Unplug with no Directory listing, or both;
--   * no contact field exists here AT ALL. Not hidden, not filtered out at
--     the API layer — absent. A column that does not exist cannot leak in a
--     SELECT *, which is the failure mode a privacy rule enforced only in
--     application code eventually hits.
--
-- Email, phone, password and role stay on `users` where they already live.

CREATE TABLE IF NOT EXISTS my_unplug_profiles (
  user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,

  -- The public handle. Stored as entered, matched case-insensitively via the
  -- unique index below, so @Sarah and @sarah cannot both exist.
  username      VARCHAR(30) NOT NULL,
  display_name  VARCHAR(60) NOT NULL,

  -- "About me", capped at 50 words by the spec. The column cap is generous
  -- (a 50-word sentence is ~350 chars); the word count itself is enforced in
  -- the route, since counting words in a CHECK is fragile.
  about_me      VARCHAR(600),

  -- One authoritative avatar, reused everywhere the member appears.
  avatar_url    TEXT,

  -- Coarse location only. Country/province/town is the granularity the spec
  -- allows publicly; street address is Directory territory and is not here.
  country       VARCHAR(80),
  province      VARCHAR(80),
  city          VARCHAR(120),

  -- OPT-IN PUBLISHING. Defaults FALSE: a profile is private until the member
  -- deliberately publishes it. Filling in a form is not consent to being
  -- listed publicly, and defaulting this to TRUE would publish everyone who
  -- ever half-completed the page.
  is_published  BOOLEAN NOT NULL DEFAULT false,
  published_at  TIMESTAMPTZ,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Handles are matched with a lowercase unique index, so keep the stored
  -- value to the same alphabet the route validates.
  CONSTRAINT my_unplug_username_format CHECK (username ~ '^[A-Za-z0-9_]{3,30}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_my_unplug_username_lower
  ON my_unplug_profiles (LOWER(username));

-- The public directory of published profiles is the only listing query that
-- matters, so it gets the index.
CREATE INDEX IF NOT EXISTS idx_my_unplug_published
  ON my_unplug_profiles (is_published, published_at DESC) WHERE is_published = true;

-- ---------------------------------------------------------------------------
-- Taxonomies. Structured rows rather than free text so they can drive
-- discovery and recommendations later — the whole point of collecting them.
-- Admin-extensible: adding a row here makes it selectable with no redeploy.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mu_interests (
  key        VARCHAR(40) PRIMARY KEY,
  label      VARCHAR(60) NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active  BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS mu_skills (
  key        VARCHAR(40) PRIMARY KEY,
  label      VARCHAR(60) NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active  BOOLEAN NOT NULL DEFAULT true
);

-- "What are you plugging into?" — what the member wants to be discovered for.
CREATE TABLE IF NOT EXISTS mu_purposes (
  key        VARCHAR(40) PRIMARY KEY,
  label      VARCHAR(60) NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active  BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS mu_profile_interests (
  user_id  INTEGER NOT NULL REFERENCES my_unplug_profiles(user_id) ON DELETE CASCADE,
  key      VARCHAR(40) NOT NULL REFERENCES mu_interests(key) ON DELETE CASCADE,
  PRIMARY KEY (user_id, key)
);
CREATE TABLE IF NOT EXISTS mu_profile_skills (
  user_id  INTEGER NOT NULL REFERENCES my_unplug_profiles(user_id) ON DELETE CASCADE,
  key      VARCHAR(40) NOT NULL REFERENCES mu_skills(key) ON DELETE CASCADE,
  PRIMARY KEY (user_id, key)
);
CREATE TABLE IF NOT EXISTS mu_profile_purposes (
  user_id  INTEGER NOT NULL REFERENCES my_unplug_profiles(user_id) ON DELETE CASCADE,
  key      VARCHAR(40) NOT NULL REFERENCES mu_purposes(key) ON DELETE CASCADE,
  PRIMARY KEY (user_id, key)
);

-- Reverse lookups for discovery ("everyone interested in photography").
CREATE INDEX IF NOT EXISTS idx_mu_profile_interests_key ON mu_profile_interests (key);
CREATE INDEX IF NOT EXISTS idx_mu_profile_skills_key    ON mu_profile_skills (key);
CREATE INDEX IF NOT EXISTS idx_mu_profile_purposes_key  ON mu_profile_purposes (key);

-- ---------------------------------------------------------------------------
-- Seeds — the lists from the brief. ON CONFLICT DO NOTHING so an admin's
-- later edits and additions survive every redeploy.
-- ---------------------------------------------------------------------------
INSERT INTO mu_interests (key, label, sort_order) VALUES
  ('business','Business',1), ('entrepreneurship','Entrepreneurship',2), ('fashion','Fashion',3),
  ('beauty','Beauty',4), ('music','Music',5), ('sport','Sport',6), ('travel','Travel',7),
  ('food','Food',8), ('technology','Technology',9), ('education','Education',10),
  ('lifestyle','Lifestyle',11), ('entertainment','Entertainment',12), ('photography','Photography',13),
  ('art','Art',14), ('culture','Culture',15), ('community','Community',16),
  ('motivation','Motivation',17), ('personal_development','Personal Development',18),
  ('finance','Finance',19), ('careers','Careers',20), ('events','Events',21)
ON CONFLICT (key) DO NOTHING;

INSERT INTO mu_skills (key, label, sort_order) VALUES
  ('photography','Photography',1), ('graphic_design','Graphic Design',2), ('marketing','Marketing',3),
  ('public_speaking','Public Speaking',4), ('writing','Writing',5), ('singing','Singing',6),
  ('dancing','Dancing',7), ('entrepreneurship','Entrepreneurship',8), ('coding','Coding',9),
  ('leadership','Leadership',10), ('coaching','Coaching',11), ('modelling','Modelling',12),
  ('acting','Acting',13), ('videography','Videography',14)
ON CONFLICT (key) DO NOTHING;

INSERT INTO mu_purposes (key, label, sort_order) VALUES
  ('talent','Talent',1), ('business','Business',2), ('creativity','Creativity',3),
  ('leadership','Leadership',4), ('sport','Sport',5), ('education','Education',6),
  ('entrepreneurship','Entrepreneurship',7), ('community_work','Community work',8),
  ('content_creation','Content creation',9), ('fashion','Fashion',10), ('music','Music',11),
  ('photography','Photography',12), ('writing','Writing',13), ('skills','Skills',14),
  ('personal_achievements','Personal achievements',15), ('other','Other',16)
ON CONFLICT (key) DO NOTHING;
