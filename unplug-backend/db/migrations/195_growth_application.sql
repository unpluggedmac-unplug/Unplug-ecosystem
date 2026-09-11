-- Growth Application core data model
-- Separate from Agreement Forms, signed_agreements, Directory, Impact Makers and participation.
-- Source boundary: the exact Deep Discovery question banks are intentionally NOT seeded here.
-- They must be imported verbatim from the original growth-application-proposal.md.

CREATE TABLE IF NOT EXISTS growth_applications (
  id                          SERIAL PRIMARY KEY,
  user_id                     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  applicant_email             VARCHAR(255) NOT NULL,
  applicant_type              VARCHAR(20) NOT NULL
                              CHECK (applicant_type IN ('individual', 'business')),

  -- Stage payloads are JSONB so the exact proposal fields/question bank can be
  -- imported verbatim without destructive schema churn or guessed columns.
  quick_profile               JSONB NOT NULL DEFAULT '{}'::jsonb,
  growth_assessment           JSONB NOT NULL DEFAULT '{}'::jsonb,
  deep_discovery_individual   JSONB NOT NULL DEFAULT '{}'::jsonb,
  deep_discovery_business     JSONB NOT NULL DEFAULT '{}'::jsonb,
  stage_progress              JSONB NOT NULL DEFAULT '{}'::jsonb,
  current_stage               VARCHAR(30) NOT NULL DEFAULT 'quick_profile'
                              CHECK (current_stage IN ('quick_profile', 'growth_assessment', 'deep_discovery', 'submitted')),

  brand_style_images          JSONB NOT NULL DEFAULT '[]'::jsonb,
  applicant_team_images       JSONB NOT NULL DEFAULT '[]'::jsonb,

  status                      VARCHAR(30) NOT NULL DEFAULT 'new'
                              CHECK (status IN ('new', 'under_review', 'contacted', 'in_progress', 'closed')),
  admin_notes                 TEXT,
  research_notes              TEXT,
  closed_reason               TEXT,

  resume_token_hash           VARCHAR(128) UNIQUE,
  resume_token_created_at     TIMESTAMPTZ,

  popia_consent               BOOLEAN NOT NULL DEFAULT FALSE,
  popia_consent_at            TIMESTAMPTZ,
  popia_consent_version       VARCHAR(60),

  question_bank_version       VARCHAR(120) NOT NULL DEFAULT 'pending-original-source',
  submitted_at                TIMESTAMPTZ,
  closed_at                   TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CHECK (jsonb_typeof(quick_profile) = 'object'),
  CHECK (jsonb_typeof(growth_assessment) = 'object'),
  CHECK (jsonb_typeof(deep_discovery_individual) = 'object'),
  CHECK (jsonb_typeof(deep_discovery_business) = 'object'),
  CHECK (jsonb_typeof(stage_progress) = 'object'),
  CHECK (jsonb_typeof(brand_style_images) = 'array'),
  CHECK (jsonb_typeof(applicant_team_images) = 'array'),
  CHECK (jsonb_array_length(brand_style_images) <= 10),
  CHECK (jsonb_array_length(applicant_team_images) <= 10),
  CHECK ((popia_consent = FALSE AND popia_consent_at IS NULL) OR popia_consent = TRUE)
);

CREATE INDEX IF NOT EXISTS idx_growth_applications_user_created
  ON growth_applications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_growth_applications_status_updated
  ON growth_applications(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_growth_applications_type
  ON growth_applications(applicant_type);

CREATE TABLE IF NOT EXISTS growth_application_tasks (
  id               SERIAL PRIMARY KEY,
  application_id   INTEGER NOT NULL REFERENCES growth_applications(id) ON DELETE CASCADE,
  title            TEXT NOT NULL CHECK (length(btrim(title)) > 0),
  due_date         DATE,
  status           VARCHAR(20) NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'in_progress', 'completed', 'cancelled')),
  created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  completed_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_growth_application_tasks_application
  ON growth_application_tasks(application_id, created_at);
CREATE INDEX IF NOT EXISTS idx_growth_application_tasks_due
  ON growth_application_tasks(status, due_date) WHERE due_date IS NOT NULL;

CREATE TABLE IF NOT EXISTS growth_application_messages (
  id                 SERIAL PRIMARY KEY,
  application_id     INTEGER NOT NULL REFERENCES growth_applications(id) ON DELETE CASCADE,
  transition_status  VARCHAR(30) NOT NULL
                     CHECK (transition_status IN ('contacted', 'in_progress', 'closed')),
  message            TEXT NOT NULL CHECK (length(btrim(message)) > 0),
  sent_by             INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_growth_application_messages_application
  ON growth_application_messages(application_id, created_at);

-- Controlled placement list. No admin free-text page names.
CREATE TABLE IF NOT EXISTS growth_application_placements (
  page_key        VARCHAR(60) PRIMARY KEY
                  CHECK (page_key IN (
                    'homepage',
                    'latest_news',
                    'directory',
                    'gallery',
                    'editions',
                    'top10',
                    'competitions',
                    'member_dashboard'
                  )),
  enabled         BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO growth_application_placements(page_key, enabled) VALUES
  ('homepage', FALSE),
  ('latest_news', FALSE),
  ('directory', FALSE),
  ('gallery', FALSE),
  ('editions', FALSE),
  ('top10', FALSE),
  ('competitions', FALSE),
  ('member_dashboard', FALSE)
ON CONFLICT (page_key) DO NOTHING;

-- Preserve every historical short code so regenerating the current code does
-- not break links that have already been shared.
CREATE TABLE IF NOT EXISTS growth_application_short_links (
  id            SERIAL PRIMARY KEY,
  short_code    VARCHAR(40) NOT NULL UNIQUE,
  is_current    BOOLEAN NOT NULL DEFAULT FALSE,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at    TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_growth_application_one_current_short_link
  ON growth_application_short_links ((is_current)) WHERE is_current = TRUE;

-- Follow the existing generic settings convention for form-level config.
INSERT INTO settings(key, value) VALUES
  ('growth_application_site_visibility', 'hidden'),
  ('growth_application_short_code', ''),
  ('growth_application_response_days', '5')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION touch_growth_application_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS growth_applications_touch_updated_at ON growth_applications;
CREATE TRIGGER growth_applications_touch_updated_at
BEFORE UPDATE ON growth_applications
FOR EACH ROW EXECUTE FUNCTION touch_growth_application_updated_at();

DROP TRIGGER IF EXISTS growth_application_tasks_touch_updated_at ON growth_application_tasks;
CREATE TRIGGER growth_application_tasks_touch_updated_at
BEFORE UPDATE ON growth_application_tasks
FOR EACH ROW EXECUTE FUNCTION touch_growth_application_updated_at();
