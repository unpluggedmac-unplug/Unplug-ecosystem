-- Deaf Community page — jobs board + Opportunity Passports + passport
-- comments. Jobs and passports are public submissions that go live for 14
-- days once an admin approves them (approval doubles as the "verification"
-- step). Passports never expose contact details publicly; the submitter's
-- email is stored only for our verification/records.

-- Jobs board: deaf-friendly employers post a vacancy; applicants apply
-- straight to apply_email. Live for 14 days from approval.
CREATE TABLE IF NOT EXISTS deaf_jobs (
  id                   SERIAL PRIMARY KEY,
  business_name        VARCHAR(200) NOT NULL,
  title                VARCHAR(200) NOT NULL,
  description          TEXT NOT NULL,          -- <= 100 words (enforced in app)
  apply_email          VARCHAR(255) NOT NULL,
  province             VARCHAR(80),
  salary_range         VARCHAR(120),
  filters              TEXT[] NOT NULL DEFAULT '{}',  -- filter tags (see route)
  deaf_friendly_agreed BOOLEAN NOT NULL DEFAULT false,
  status               VARCHAR(20) NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at           TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '14 days')
);
CREATE INDEX IF NOT EXISTS idx_deaf_jobs_live ON deaf_jobs (status, expires_at);

-- Opportunity Passports: a Deaf user's living digital card. No contact
-- details are shown publicly; email is for verification only.
CREATE TABLE IF NOT EXISTS deaf_passports (
  id                        SERIAL PRIMARY KEY,
  name                      VARCHAR(200) NOT NULL,
  profile_image_url         TEXT,
  skills                    TEXT,
  certifications            TEXT,
  communication_preferences TEXT,
  availability              VARCHAR(160),
  email                     VARCHAR(255) NOT NULL,   -- private: verification only
  status                    VARCHAR(20) NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at                TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '14 days')
);
CREATE INDEX IF NOT EXISTS idx_deaf_passports_live ON deaf_passports (status, expires_at);

-- Comments visitors leave on a passport (the only interaction allowed).
CREATE TABLE IF NOT EXISTS deaf_passport_comments (
  id             SERIAL PRIMARY KEY,
  passport_id    INTEGER NOT NULL REFERENCES deaf_passports(id) ON DELETE CASCADE,
  commenter_name VARCHAR(120),
  comment        TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_deaf_passport_comments ON deaf_passport_comments (passport_id, created_at);
