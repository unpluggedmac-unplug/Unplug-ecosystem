-- Growth Application V2
-- Configurable/versioned master form, resumable member drafts, append-only answer history,
-- selective reopen, private upload metadata, information requests and admin-only growth planning.
-- Agreement Forms remain a separate domain.

CREATE TABLE IF NOT EXISTS growth_forms (
  id            BIGSERIAL PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  description   TEXT,
  is_master     BOOLEAN NOT NULL DEFAULT false,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS growth_forms_one_master_idx
  ON growth_forms ((is_master)) WHERE is_master = true;

CREATE TABLE IF NOT EXISTS growth_form_versions (
  id              BIGSERIAL PRIMARY KEY,
  form_id         BIGINT NOT NULL REFERENCES growth_forms(id) ON DELETE CASCADE,
  version_number  INTEGER NOT NULL CHECK (version_number > 0),
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','retired')),
  title           TEXT NOT NULL,
  intro_text      TEXT,
  consent_text    TEXT,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  published_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at    TIMESTAMPTZ,
  retired_at      TIMESTAMPTZ,
  UNIQUE(form_id, version_number)
);
CREATE UNIQUE INDEX IF NOT EXISTS growth_form_versions_one_published_idx
  ON growth_form_versions(form_id) WHERE status = 'published';

CREATE TABLE IF NOT EXISTS growth_form_steps (
  id             BIGSERIAL PRIMARY KEY,
  version_id     BIGINT NOT NULL REFERENCES growth_form_versions(id) ON DELETE CASCADE,
  step_key       TEXT NOT NULL,
  title          TEXT NOT NULL,
  description    TEXT,
  display_order  INTEGER NOT NULL DEFAULT 0,
  is_enabled     BOOLEAN NOT NULL DEFAULT true,
  UNIQUE(version_id, step_key)
);
CREATE INDEX IF NOT EXISTS growth_form_steps_version_order_idx
  ON growth_form_steps(version_id, display_order, id);

CREATE TABLE IF NOT EXISTS growth_form_fields (
  id                        BIGSERIAL PRIMARY KEY,
  version_id                BIGINT NOT NULL REFERENCES growth_form_versions(id) ON DELETE CASCADE,
  step_id                   BIGINT NOT NULL REFERENCES growth_form_steps(id) ON DELETE CASCADE,
  field_key                 TEXT NOT NULL,
  label                     TEXT NOT NULL,
  help_text                 TEXT,
  placeholder               TEXT,
  field_type                TEXT NOT NULL CHECK (field_type IN (
                              'text','textarea','number','email','tel','date','url',
                              'select','multiselect','radio','checkbox','yes_no','upload'
                            )),
  display_order             INTEGER NOT NULL DEFAULT 0,
  is_required               BOOLEAN NOT NULL DEFAULT false,
  is_enabled                BOOLEAN NOT NULL DEFAULT true,
  sensitive                 BOOLEAN NOT NULL DEFAULT false,
  sensitive_enabled         BOOLEAN NOT NULL DEFAULT false,
  confidential              BOOLEAN NOT NULL DEFAULT false,
  allow_external_sharing    BOOLEAN NOT NULL DEFAULT false,
  applicant_types           JSONB NOT NULL DEFAULT '["individual","business"]'::jsonb,
  validation_rules          JSONB NOT NULL DEFAULT '{}'::jsonb,
  visibility_rules          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(applicant_types) = 'array'),
  CHECK (jsonb_typeof(validation_rules) = 'object'),
  CHECK (jsonb_typeof(visibility_rules) = 'object'),
  CHECK (sensitive = false OR sensitive_enabled = true OR is_enabled = false),
  UNIQUE(version_id, field_key)
);
CREATE INDEX IF NOT EXISTS growth_form_fields_step_order_idx
  ON growth_form_fields(step_id, display_order, id);

CREATE TABLE IF NOT EXISTS growth_form_field_options (
  id             BIGSERIAL PRIMARY KEY,
  field_id       BIGINT NOT NULL REFERENCES growth_form_fields(id) ON DELETE CASCADE,
  option_value   TEXT NOT NULL,
  option_label   TEXT NOT NULL,
  display_order  INTEGER NOT NULL DEFAULT 0,
  is_enabled     BOOLEAN NOT NULL DEFAULT true,
  UNIQUE(field_id, option_value)
);

INSERT INTO growth_forms (slug, name, description, is_master, is_active)
VALUES ('master-growth-application', 'Master Growth Application',
        'The configurable master Growth Application used by Unplug members.', true, true)
ON CONFLICT (slug) DO NOTHING;

ALTER TABLE growth_applications
  ADD COLUMN IF NOT EXISTS form_version_id BIGINT REFERENCES growth_form_versions(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS completion_percent INTEGER NOT NULL DEFAULT 0 CHECK (completion_percent BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS last_saved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS withdrawn_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS withdrawn_reason TEXT,
  ADD COLUMN IF NOT EXISTS external_sharing_allowed BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS external_sharing_consent_at TIMESTAMPTZ;

ALTER TABLE growth_applications DROP CONSTRAINT IF EXISTS growth_applications_status_check;
ALTER TABLE growth_applications ADD CONSTRAINT growth_applications_status_check
  CHECK (status IN (
    'draft','new','submitted','under_review','information_requested','assessment_in_progress',
    'plan_in_progress','in_progress','completed','withdrawn','closed','contacted'
  ));

CREATE INDEX IF NOT EXISTS growth_applications_form_version_idx
  ON growth_applications(form_version_id);
CREATE INDEX IF NOT EXISTS growth_applications_member_status_idx
  ON growth_applications(user_id, status, updated_at DESC);

-- Answers are append-only. Saving an edited value creates a new revision; old values are never overwritten.
CREATE TABLE IF NOT EXISTS growth_application_answer_revisions (
  id              BIGSERIAL PRIMARY KEY,
  application_id  INTEGER NOT NULL REFERENCES growth_applications(id) ON DELETE CASCADE,
  field_id        BIGINT REFERENCES growth_form_fields(id) ON DELETE SET NULL,
  field_key       TEXT NOT NULL,
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  value_json      JSONB NOT NULL DEFAULT 'null'::jsonb,
  saved_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  save_source     TEXT NOT NULL DEFAULT 'member' CHECK (save_source IN ('member','admin_reopen','information_request')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(application_id, field_key, revision_number)
);
CREATE INDEX IF NOT EXISTS growth_answer_revisions_latest_idx
  ON growth_application_answer_revisions(application_id, field_key, revision_number DESC);

-- Admin can selectively reopen individual submitted fields without unlocking the whole application.
CREATE TABLE IF NOT EXISTS growth_application_field_reopens (
  id              BIGSERIAL PRIMARY KEY,
  application_id  INTEGER NOT NULL REFERENCES growth_applications(id) ON DELETE CASCADE,
  field_key       TEXT NOT NULL,
  reason          TEXT,
  opened_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  opened_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at       TIMESTAMPTZ,
  UNIQUE(application_id, field_key, opened_at)
);
CREATE INDEX IF NOT EXISTS growth_field_reopens_open_idx
  ON growth_application_field_reopens(application_id, field_key) WHERE closed_at IS NULL;

CREATE TABLE IF NOT EXISTS growth_information_requests (
  id              BIGSERIAL PRIMARY KEY,
  application_id  INTEGER NOT NULL REFERENCES growth_applications(id) ON DELETE CASCADE,
  request_text    TEXT NOT NULL CHECK (length(btrim(request_text)) > 0),
  requested_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','responded','closed','cancelled')),
  requested_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  requested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at    TIMESTAMPTZ,
  closed_at       TIMESTAMPTZ,
  CHECK (jsonb_typeof(requested_fields) = 'array')
);
CREATE INDEX IF NOT EXISTS growth_information_requests_application_idx
  ON growth_information_requests(application_id, status, requested_at DESC);

CREATE TABLE IF NOT EXISTS growth_information_responses (
  id              BIGSERIAL PRIMARY KEY,
  request_id      BIGINT NOT NULL REFERENCES growth_information_requests(id) ON DELETE CASCADE,
  application_id  INTEGER NOT NULL REFERENCES growth_applications(id) ON DELETE CASCADE,
  response_text   TEXT,
  response_data   JSONB NOT NULL DEFAULT '{}'::jsonb,
  responded_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(response_data) = 'object')
);

-- Upload metadata only. Object bytes live in the private R2 bucket.
CREATE TABLE IF NOT EXISTS growth_uploads (
  id                      BIGSERIAL PRIMARY KEY,
  application_id          INTEGER NOT NULL REFERENCES growth_applications(id) ON DELETE CASCADE,
  field_key               TEXT,
  object_key              TEXT NOT NULL,
  original_filename       TEXT,
  mime_type               TEXT NOT NULL,
  size_bytes              BIGINT NOT NULL CHECK (size_bytes >= 0),
  confidential            BOOLEAN NOT NULL DEFAULT true,
  external_sharing_allowed BOOLEAN NOT NULL DEFAULT false,
  uploaded_by             INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS growth_uploads_application_idx
  ON growth_uploads(application_id, created_at DESC);

-- Optional links to the rest of Unplug remain relational; the Growth record is never owned by these entities.
CREATE TABLE IF NOT EXISTS growth_application_entity_links (
  id              BIGSERIAL PRIMARY KEY,
  application_id  INTEGER NOT NULL REFERENCES growth_applications(id) ON DELETE CASCADE,
  entity_type     TEXT NOT NULL CHECK (entity_type IN ('member','business','opportunity','service_order','campaign','agreement')),
  entity_id       TEXT NOT NULL,
  relationship    TEXT,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(application_id, entity_type, entity_id)
);

-- Admin-only assessment/planning domain. Member endpoints must never serialise these tables.
CREATE TABLE IF NOT EXISTS growth_assessments (
  id                    BIGSERIAL PRIMARY KEY,
  application_id        INTEGER NOT NULL UNIQUE REFERENCES growth_applications(id) ON DELETE CASCADE,
  strengths             TEXT,
  challenges            TEXT,
  readiness_score       NUMERIC(5,2),
  credibility_score     NUMERIC(5,2),
  exposure_score        NUMERIC(5,2),
  opportunity_score     NUMERIC(5,2),
  growth_score          NUMERIC(5,2),
  internal_notes        TEXT,
  assessed_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (readiness_score IS NULL OR readiness_score BETWEEN 0 AND 100),
  CHECK (credibility_score IS NULL OR credibility_score BETWEEN 0 AND 100),
  CHECK (exposure_score IS NULL OR exposure_score BETWEEN 0 AND 100),
  CHECK (opportunity_score IS NULL OR opportunity_score BETWEEN 0 AND 100),
  CHECK (growth_score IS NULL OR growth_score BETWEEN 0 AND 100)
);

CREATE TABLE IF NOT EXISTS growth_priorities (
  id              BIGSERIAL PRIMARY KEY,
  application_id  INTEGER NOT NULL REFERENCES growth_applications(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  detail          TEXT,
  priority_order  INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'identified' CHECK (status IN ('identified','planned','in_progress','completed','dismissed')),
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS growth_opportunities (
  id              BIGSERIAL PRIMARY KEY,
  application_id  INTEGER NOT NULL REFERENCES growth_applications(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  detail          TEXT,
  opportunity_type TEXT,
  internal_only   BOOLEAN NOT NULL DEFAULT true,
  status          TEXT NOT NULL DEFAULT 'identified' CHECK (status IN ('identified','considering','actioned','completed','declined')),
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS growth_plans (
  id              BIGSERIAL PRIMARY KEY,
  application_id  INTEGER NOT NULL UNIQUE REFERENCES growth_applications(id) ON DELETE CASCADE,
  objective       TEXT,
  strategy        TEXT,
  internal_notes  TEXT,
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','completed','archived')),
  review_at       TIMESTAMPTZ,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS growth_plan_items (
  id              BIGSERIAL PRIMARY KEY,
  plan_id         BIGINT NOT NULL REFERENCES growth_plans(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  description     TEXT,
  owner_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  due_date        DATE,
  display_order   INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started','in_progress','blocked','completed','cancelled')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS growth_progress_updates (
  id              BIGSERIAL PRIMARY KEY,
  application_id  INTEGER NOT NULL REFERENCES growth_applications(id) ON DELETE CASCADE,
  update_text     TEXT NOT NULL,
  internal_only   BOOLEAN NOT NULL DEFAULT true,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS growth_outcomes (
  id              BIGSERIAL PRIMARY KEY,
  application_id  INTEGER NOT NULL UNIQUE REFERENCES growth_applications(id) ON DELETE CASCADE,
  outcome_summary TEXT,
  outcome_code    TEXT,
  future_review_at TIMESTAMPTZ,
  internal_notes  TEXT,
  closed_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS growth_status_history (
  id              BIGSERIAL PRIMARY KEY,
  application_id  INTEGER NOT NULL REFERENCES growth_applications(id) ON DELETE CASCADE,
  from_status     TEXT,
  to_status       TEXT NOT NULL,
  changed_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS growth_status_history_application_idx
  ON growth_status_history(application_id, created_at DESC);

-- Seed Growth permissions conservatively. Existing customised staff roles are never reset.
-- Support can review/manage ordinary Growth records, but sensitive data is opt-in and is not seeded.
INSERT INTO staff_role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM staff_roles r
JOIN (VALUES
  ('support', 'growth.view'),
  ('support', 'growth.manage')
) AS p(slug, permission) ON p.slug = r.slug
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION touch_growth_v2_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS growth_forms_touch_updated_at ON growth_forms;
CREATE TRIGGER growth_forms_touch_updated_at BEFORE UPDATE ON growth_forms
FOR EACH ROW EXECUTE FUNCTION touch_growth_v2_updated_at();
DROP TRIGGER IF EXISTS growth_assessments_touch_updated_at ON growth_assessments;
CREATE TRIGGER growth_assessments_touch_updated_at BEFORE UPDATE ON growth_assessments
FOR EACH ROW EXECUTE FUNCTION touch_growth_v2_updated_at();
DROP TRIGGER IF EXISTS growth_plans_touch_updated_at ON growth_plans;
CREATE TRIGGER growth_plans_touch_updated_at BEFORE UPDATE ON growth_plans
FOR EACH ROW EXECUTE FUNCTION touch_growth_v2_updated_at();
DROP TRIGGER IF EXISTS growth_outcomes_touch_updated_at ON growth_outcomes;
CREATE TRIGGER growth_outcomes_touch_updated_at BEFORE UPDATE ON growth_outcomes
FOR EACH ROW EXECUTE FUNCTION touch_growth_v2_updated_at();
