-- Agreement Generator — master-template and individual-agreement lifecycle.
--
-- This migration EXTENDS the existing Agreement Forms system introduced in 190.
-- It deliberately does not touch the legacy signed_agreements / /agreements system.
-- All changes are additive/idempotent: production data must never be reset,
-- truncated, seeded destructively or silently rewritten.

-- ---------------------------------------------------------------------------
-- Master template lifecycle and configuration
-- ---------------------------------------------------------------------------
ALTER TABLE agreement_templates DROP CONSTRAINT IF EXISTS agreement_templates_signer_type_check;
ALTER TABLE agreement_templates
  ADD CONSTRAINT agreement_templates_signer_type_check
  CHECK (signer_type IN ('individual', 'business', 'choice'));

ALTER TABLE agreement_forms DROP CONSTRAINT IF EXISTS agreement_forms_signer_type_check;
ALTER TABLE agreement_forms
  ADD CONSTRAINT agreement_forms_signer_type_check
  CHECK (signer_type IN ('individual', 'business', 'choice'));

ALTER TABLE agreement_forms
  ADD COLUMN IF NOT EXISTS approval_status VARCHAR(30) NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS access_method VARCHAR(30) NOT NULL DEFAULT 'private_link',
  ADD COLUMN IF NOT EXISTS signing_order VARCHAR(30) NOT NULL DEFAULT 'party_b_first',
  ADD COLUMN IF NOT EXISTS delivery_config JSONB NOT NULL DEFAULT '{"save_notify_unplug":true,"email_party_b":false,"allow_download":true,"manual_download_email":false}'::jsonb,
  ADD COLUMN IF NOT EXISTS notification_config JSONB NOT NULL DEFAULT '{"recipients":["info@unplugnews.com"],"reminders":[]}'::jsonb,
  ADD COLUMN IF NOT EXISTS declarations JSONB NOT NULL DEFAULT '[]'::jsonb;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='agreement_forms_approval_status_check') THEN
    ALTER TABLE agreement_forms ADD CONSTRAINT agreement_forms_approval_status_check
      CHECK (approval_status IN ('draft','legal_review','approved','published','retired'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='agreement_forms_access_method_check') THEN
    ALTER TABLE agreement_forms ADD CONSTRAINT agreement_forms_access_method_check
      CHECK (access_method IN ('private_link','member_login','both'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='agreement_forms_signing_order_check') THEN
    ALTER TABLE agreement_forms ADD CONSTRAINT agreement_forms_signing_order_check
      CHECK (signing_order IN ('party_b_first','party_a_first'));
  END IF;
END $$;

-- Field metadata powers the eleven master sections, conditional visibility and
-- POPIA-sensitive identity controls. ID/passport collection remains OFF unless
-- an admin explicitly enables it with a documented purpose, retention period
-- and access description.
ALTER TABLE template_fields
  ADD COLUMN IF NOT EXISTS section_key VARCHAR(80),
  ADD COLUMN IF NOT EXISTS party_scope VARCHAR(40),
  ADD COLUMN IF NOT EXISTS condition_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS config JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS sensitive_type VARCHAR(40),
  ADD COLUMN IF NOT EXISTS popia_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS popia_purpose TEXT,
  ADD COLUMN IF NOT EXISTS popia_retention TEXT,
  ADD COLUMN IF NOT EXISTS popia_access TEXT,
  ADD COLUMN IF NOT EXISTS popia_ack_required BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE agreement_fields
  ADD COLUMN IF NOT EXISTS section_key VARCHAR(80),
  ADD COLUMN IF NOT EXISTS party_scope VARCHAR(40),
  ADD COLUMN IF NOT EXISTS condition_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS config JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS sensitive_type VARCHAR(40),
  ADD COLUMN IF NOT EXISTS popia_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS popia_purpose TEXT,
  ADD COLUMN IF NOT EXISTS popia_retention TEXT,
  ADD COLUMN IF NOT EXISTS popia_access TEXT,
  ADD COLUMN IF NOT EXISTS popia_ack_required BOOLEAN NOT NULL DEFAULT false;

-- One-time-safe conversion of the old required ID/passport starter field. The
-- sensitive_type IS NULL predicate makes this safe when migrations are replayed:
-- once converted, a later administrator choice is never silently overwritten.
UPDATE template_fields
   SET required=false, sensitive_type='identity_document', popia_enabled=false
 WHERE LOWER(field_key) IN ('id_or_passport','id_number','passport_number')
   AND sensitive_type IS NULL;
UPDATE agreement_fields
   SET required=false, sensitive_type='identity_document', popia_enabled=false
 WHERE LOWER(field_key) IN ('id_or_passport','id_number','passport_number')
   AND sensitive_type IS NULL;

-- Immutable definition snapshots. Existing signed rows already have
-- definition_at_signing; this table adds version lineage for every new
-- individual agreement created from a template.
CREATE TABLE IF NOT EXISTS agreement_form_versions (
  id                 BIGSERIAL PRIMARY KEY,
  agreement_id       INTEGER NOT NULL REFERENCES agreement_forms(id) ON DELETE RESTRICT,
  version            INTEGER NOT NULL CHECK (version > 0),
  snapshot           JSONB NOT NULL,
  approval_status    VARCHAR(30) NOT NULL DEFAULT 'draft',
  created_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agreement_id, version)
);
CREATE INDEX IF NOT EXISTS idx_agreement_form_versions_latest
  ON agreement_form_versions (agreement_id, version DESC);

CREATE TABLE IF NOT EXISTS agreement_template_approval_history (
  id              BIGSERIAL PRIMARY KEY,
  agreement_id    INTEGER NOT NULL REFERENCES agreement_forms(id) ON DELETE RESTRICT,
  version         INTEGER NOT NULL,
  from_status     VARCHAR(30),
  to_status       VARCHAR(30) NOT NULL,
  reviewer_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reason          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agreement_template_approval_history
  ON agreement_template_approval_history (agreement_id, version, created_at DESC);

-- Reusable rich-text clause library and per-template clause composition.
CREATE TABLE IF NOT EXISTS agreement_clause_blocks (
  id              BIGSERIAL PRIMARY KEY,
  name            VARCHAR(180) NOT NULL,
  category        VARCHAR(120),
  body_html       TEXT NOT NULL,
  active          BOOLEAN NOT NULL DEFAULT true,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agreement_clause_blocks_name
  ON agreement_clause_blocks (LOWER(name));

CREATE TABLE IF NOT EXISTS agreement_form_clauses (
  id              BIGSERIAL PRIMARY KEY,
  agreement_id    INTEGER NOT NULL REFERENCES agreement_forms(id) ON DELETE CASCADE,
  clause_block_id BIGINT REFERENCES agreement_clause_blocks(id) ON DELETE SET NULL,
  position        INTEGER NOT NULL DEFAULT 0,
  title           VARCHAR(220),
  body_html       TEXT,
  condition_json  JSONB NOT NULL DEFAULT '{}'::jsonb,
  excluded        BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agreement_form_clauses_order
  ON agreement_form_clauses (agreement_id, position, id);

-- Notes and upload requirements share one ordered model and the exact three
-- visibility choices from the product specification.
CREATE TABLE IF NOT EXISTS agreement_form_items (
  id              BIGSERIAL PRIMARY KEY,
  agreement_id    INTEGER NOT NULL REFERENCES agreement_forms(id) ON DELETE CASCADE,
  position        INTEGER NOT NULL DEFAULT 0,
  kind            VARCHAR(20) NOT NULL CHECK (kind IN ('note','upload')),
  label           VARCHAR(220) NOT NULL,
  help            TEXT,
  visibility      VARCHAR(30) NOT NULL DEFAULT 'party_b_visible'
                  CHECK (visibility IN ('internal_admin','party_b_visible','party_b_required')),
  required        BOOLEAN NOT NULL DEFAULT false,
  condition_json  JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agreement_form_items_order
  ON agreement_form_items (agreement_id, position, id);

-- ---------------------------------------------------------------------------
-- Individual Agreement lifecycle
-- ---------------------------------------------------------------------------
ALTER TABLE agreement_submissions DROP CONSTRAINT IF EXISTS agreement_submissions_signature_type_check;
ALTER TABLE agreement_submissions
  ADD CONSTRAINT agreement_submissions_signature_type_check
  CHECK (signature_type IS NULL OR signature_type IN ('typed','drawn','uploaded'));

ALTER TABLE agreement_submissions
  ADD COLUMN IF NOT EXISTS workflow_status VARCHAR(30) NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS template_version_id BIGINT REFERENCES agreement_form_versions(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS party_b_type VARCHAR(20),
  ADD COLUMN IF NOT EXISTS access_method VARCHAR(30),
  ADD COLUMN IF NOT EXISTS signing_order VARCHAR(30),
  ADD COLUMN IF NOT EXISTS delivery_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS notification_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS draft_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS declarations_accepted JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS last_saved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reopened_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS verification_channel VARCHAR(20),
  ADD COLUMN IF NOT EXISTS reference_original VARCHAR(80),
  ADD COLUMN IF NOT EXISTS reference_override_reason TEXT,
  ADD COLUMN IF NOT EXISTS party_a_signed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS party_b_signed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS superseded_by_id INTEGER REFERENCES agreement_submissions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='agreement_submissions_workflow_status_check') THEN
    ALTER TABLE agreement_submissions ADD CONSTRAINT agreement_submissions_workflow_status_check
      CHECK (workflow_status IN ('draft','sent','in_progress','submitted','under_review','signed','completed','archived'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='agreement_submissions_party_b_type_check') THEN
    ALTER TABLE agreement_submissions ADD CONSTRAINT agreement_submissions_party_b_type_check
      CHECK (party_b_type IS NULL OR party_b_type IN ('individual','business'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='agreement_submissions_access_method_check') THEN
    ALTER TABLE agreement_submissions ADD CONSTRAINT agreement_submissions_access_method_check
      CHECK (access_method IS NULL OR access_method IN ('private_link','member_login','both'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='agreement_submissions_signing_order_check') THEN
    ALTER TABLE agreement_submissions ADD CONSTRAINT agreement_submissions_signing_order_check
      CHECK (signing_order IS NULL OR signing_order IN ('party_b_first','party_a_first'));
  END IF;
END $$;

UPDATE agreement_submissions
   SET reference_original = reference
 WHERE reference_original IS NULL AND reference IS NOT NULL;
UPDATE agreement_submissions
   SET workflow_status='signed'
 WHERE signed_at IS NOT NULL AND workflow_status='draft';

CREATE INDEX IF NOT EXISTS idx_agreement_submissions_workflow
  ON agreement_submissions (workflow_status, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_agreement_submissions_template_version
  ON agreement_submissions (template_version_id);
CREATE INDEX IF NOT EXISTS idx_agreement_submissions_superseded
  ON agreement_submissions (superseded_by_id);

-- Multiple Party A / Party B participants and capacities.
CREATE TABLE IF NOT EXISTS agreement_submission_parties (
  id              BIGSERIAL PRIMARY KEY,
  submission_id   INTEGER NOT NULL REFERENCES agreement_submissions(id) ON DELETE RESTRICT,
  party_side      VARCHAR(10) NOT NULL CHECK (party_side IN ('party_a','party_b')),
  party_type      VARCHAR(20) NOT NULL CHECK (party_type IN ('individual','business')),
  role            VARCHAR(40) NOT NULL DEFAULT 'primary'
                  CHECK (role IN ('primary','guardian','witness','authorised_representative','other')),
  legal_name      VARCHAR(240),
  display_name    VARCHAR(240),
  email           VARCHAR(255),
  mobile          VARCHAR(80),
  capacity        VARCHAR(180),
  sign_order      INTEGER NOT NULL DEFAULT 0,
  required        BOOLEAN NOT NULL DEFAULT true,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agreement_submission_parties
  ON agreement_submission_parties (submission_id, party_side, sign_order, id);

CREATE TABLE IF NOT EXISTS agreement_signatures (
  id                  BIGSERIAL PRIMARY KEY,
  submission_id       INTEGER NOT NULL REFERENCES agreement_submissions(id) ON DELETE RESTRICT,
  party_id            BIGINT REFERENCES agreement_submission_parties(id) ON DELETE RESTRICT,
  party_side          VARCHAR(10) NOT NULL CHECK (party_side IN ('party_a','party_b')),
  signature_type      VARCHAR(20) NOT NULL CHECK (signature_type IN ('typed','drawn','uploaded')),
  signature_text      TEXT,
  signature_url       TEXT,
  declaration_accepted BOOLEAN NOT NULL DEFAULT true,
  ip                  TEXT,
  user_agent          TEXT,
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  signed_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agreement_signatures_submission
  ON agreement_signatures (submission_id, party_side, signed_at, id);

CREATE TABLE IF NOT EXISTS agreement_submission_items (
  id              BIGSERIAL PRIMARY KEY,
  submission_id   INTEGER NOT NULL REFERENCES agreement_submissions(id) ON DELETE RESTRICT,
  form_item_id    BIGINT REFERENCES agreement_form_items(id) ON DELETE SET NULL,
  note_text       TEXT,
  upload_url      TEXT,
  submitted_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (submission_id, form_item_id)
);

-- OTP codes are never stored in plaintext. Mobile delivery is optional at
-- runtime; email verification works with the existing mail infrastructure.
CREATE TABLE IF NOT EXISTS agreement_verification_codes (
  id              BIGSERIAL PRIMARY KEY,
  submission_id   INTEGER NOT NULL REFERENCES agreement_submissions(id) ON DELETE CASCADE,
  channel         VARCHAR(20) NOT NULL CHECK (channel IN ('email','mobile')),
  destination     VARCHAR(255) NOT NULL,
  code_hash       VARCHAR(128) NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  consumed_at     TIMESTAMPTZ,
  attempts        INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agreement_verification_active
  ON agreement_verification_codes (submission_id, channel, created_at DESC);

-- Staff can only work an individual agreement where their role permits the
-- module and the agreement is explicitly assigned to them.
CREATE TABLE IF NOT EXISTS agreement_submission_assignments (
  submission_id   INTEGER NOT NULL REFERENCES agreement_submissions(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  assignment_role VARCHAR(80),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (submission_id, user_id)
);

-- Complete append-only audit trail. Reopens, reference overrides, status
-- transitions and signatures all write here; signed content is never erased.
CREATE TABLE IF NOT EXISTS agreement_audit_log (
  id              BIGSERIAL PRIMARY KEY,
  agreement_id    INTEGER REFERENCES agreement_forms(id) ON DELETE RESTRICT,
  submission_id   INTEGER REFERENCES agreement_submissions(id) ON DELETE RESTRICT,
  actor_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_role      VARCHAR(40),
  action          VARCHAR(100) NOT NULL,
  from_status     VARCHAR(30),
  to_status       VARCHAR(30),
  reason          TEXT,
  details         JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip              TEXT,
  user_agent      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agreement_audit_submission
  ON agreement_audit_log (submission_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_agreement_audit_template
  ON agreement_audit_log (agreement_id, created_at DESC, id DESC);

-- Sequential per-year public references: UNP-AGR-2026-0001. Row-level locking
-- in INSERT ... ON CONFLICT DO UPDATE makes concurrent allocation safe.
CREATE TABLE IF NOT EXISTS agreement_reference_sequences (
  year_value      INTEGER PRIMARY KEY,
  last_value      INTEGER NOT NULL DEFAULT 0 CHECK (last_value >= 0),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Required preset names. Existing historical presets are kept; no template is
-- deleted or renamed behind an administrator's back.
-- ---------------------------------------------------------------------------
INSERT INTO agreement_templates
  (name, category, title, description, signer_type, rules, terms,
   post_signing_requirements, payment_mode, require_witness,
   require_company_stamp, is_builtin)
VALUES
  ('Model / Photo / Video Release', 'Media & Content', 'Model / Photo / Video Release',
   'Consent and permissions for photography, video, likeness, publication and agreed media use.',
   'individual', '', '', '', 'none', false, false, true),
  ('Sponsorship Agreement', 'Sponsorship', 'Sponsorship Agreement',
   'Sponsorship scope, benefits, obligations, brand use, delivery and commercial terms.',
   'choice', '', '', '', 'none', false, false, true),
  ('Independent Contractor / Freelancer Agreement', 'Services', 'Independent Contractor / Freelancer Agreement',
   'Independent contractor or freelance services, deliverables, rights, payment and responsibilities.',
   'choice', '', '', '', 'none', false, false, true),
  ('Contributor / Content Submission Agreement', 'Media & Content', 'Contributor / Content Submission Agreement',
   'Content contribution, originality, publication permissions, rights and contributor responsibilities.',
   'choice', '', '', '', 'none', false, false, true),
  ('Event Participation Agreement', 'Events', 'Event Participation Agreement',
   'Participation, conduct, media, risk and delivery terms for an event or activation.',
   'choice', '', '', '', 'none', false, false, true),
  ('Influencer / Brand Collaboration Agreement', 'Partnerships', 'Influencer / Brand Collaboration Agreement',
   'Campaign scope, deliverables, disclosures, brand use, content rights and commercial terms.',
   'choice', '', '', '', 'none', false, false, true),
  ('Confidentiality / NDA', 'Legal', 'Confidentiality / Non-Disclosure Agreement',
   'Confidentiality, permitted disclosure, exclusions, handling and return of protected information.',
   'choice', '', '', '', 'none', false, false, true),
  ('Advertising / Promotional Services Agreement', 'Advertising', 'Advertising / Promotional Services Agreement',
   'Advertising or promotional scope, placement, deliverables, brand assets, payment and usage terms.',
   'choice', '', '', '', 'none', false, false, true)
ON CONFLICT ((LOWER(name))) DO NOTHING;
