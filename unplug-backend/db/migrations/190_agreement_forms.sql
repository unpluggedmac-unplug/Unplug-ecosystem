-- Agreement Forms — reconstructed from the preserved handover and locked
-- 2026-09-10 implementation decisions.
--
-- IMPORTANT:
-- * This is intentionally separate from the existing signed_agreements system.
-- * It reuses users.role='consultant' + sales_consultants; no duplicate role.
-- * Every statement is safe to run repeatedly because migrations run on every
--   backend boot in this repository.
-- * Migration number 190 is deliberate: 183-189 are already occupied on the
--   staging-control-centre lineage.

-- ---------------------------------------------------------------------------
-- Reusable agreement templates
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agreement_templates (
  id                         SERIAL PRIMARY KEY,
  name                       VARCHAR(160) NOT NULL,
  category                   VARCHAR(120),
  title                      VARCHAR(220) NOT NULL,
  description                TEXT,
  signer_type                VARCHAR(20) NOT NULL DEFAULT 'individual'
                             CHECK (signer_type IN ('individual', 'business')),
  rules                      TEXT,
  terms                      TEXT,
  post_signing_requirements  TEXT,
  amount                     NUMERIC(10,2),
  payment_mode               VARCHAR(20) NOT NULL DEFAULT 'none'
                             CHECK (payment_mode IN ('none', 'before_sign', 'after_sign')),
  min_age                    INTEGER,
  require_witness            BOOLEAN NOT NULL DEFAULT false,
  require_company_stamp      BOOLEAN NOT NULL DEFAULT false,
  is_builtin                 BOOLEAN NOT NULL DEFAULT false,
  created_by                 INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agreement_templates_name
  ON agreement_templates (LOWER(name));

CREATE TABLE IF NOT EXISTS template_fields (
  id             SERIAL PRIMARY KEY,
  template_id    INTEGER NOT NULL REFERENCES agreement_templates(id) ON DELETE CASCADE,
  position       INTEGER NOT NULL DEFAULT 0,
  kind           VARCHAR(20) NOT NULL
                 CHECK (kind IN ('text', 'email', 'phone', 'textarea', 'number',
                                 'date', 'select', 'radio', 'checkbox', 'file')),
  field_key      VARCHAR(60) NOT NULL,
  label          VARCHAR(200) NOT NULL,
  placeholder    VARCHAR(200),
  help           TEXT,
  required       BOOLEAN NOT NULL DEFAULT false,
  options        JSONB NOT NULL DEFAULT '[]'::jsonb,
  max_length     INTEGER,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_template_fields_key
  ON template_fields (template_id, LOWER(field_key));
CREATE INDEX IF NOT EXISTS idx_template_fields_order
  ON template_fields (template_id, position, id);

-- ---------------------------------------------------------------------------
-- Agreement definition
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agreement_forms (
  id                         SERIAL PRIMARY KEY,
  template_id                INTEGER REFERENCES agreement_templates(id) ON DELETE SET NULL,
  name                       VARCHAR(160) NOT NULL,
  slug                       VARCHAR(100) NOT NULL,
  title                      VARCHAR(220) NOT NULL,
  description                TEXT,
  category                   VARCHAR(120),
  signer_type                VARCHAR(20) NOT NULL DEFAULT 'individual'
                             CHECK (signer_type IN ('individual', 'business')),
  rules                      TEXT,
  terms                      TEXT,
  post_signing_requirements  TEXT,

  -- Visible contract revision number. Editing the agreement increments this in
  -- application code; every submission snapshots the number it signed under.
  version                    INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),

  -- Draft/active/archive is separate from publication. A direct link may work
  -- for an unpublished active agreement; public discovery never assumes that.
  status                     VARCHAR(20) NOT NULL DEFAULT 'draft'
                             CHECK (status IN ('draft', 'active', 'archived')),
  published                  BOOLEAN NOT NULL DEFAULT false,
  opens_at                   TIMESTAMPTZ,
  closes_at                  TIMESTAMPTZ,

  min_age                    INTEGER,
  require_witness            BOOLEAN NOT NULL DEFAULT false,
  require_company_stamp      BOOLEAN NOT NULL DEFAULT false,

  -- Admin chooses whether the agreement is surfaced publicly and on which
  -- approved Unplug pages. Direct-link signing does not require public display.
  public_pages               JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Agreements may belong to either a real on-site Unplug service or an
  -- external/off-site service. These fields let admin describe the latter
  -- without inventing a website service record.
  service_scope              VARCHAR(20) NOT NULL DEFAULT 'website'
                             CHECK (service_scope IN ('website', 'external')),
  service_name               VARCHAR(200),
  service_description        TEXT,
  service_reference          VARCHAR(160),
  client_name                VARCHAR(200),

  -- Admin chooses per agreement: no payment, pay before signing, or sign first
  -- and then pay. Amount is always stored server-side and never trusted from a
  -- signing client.
  amount                     NUMERIC(10,2),
  payment_mode               VARCHAR(20) NOT NULL DEFAULT 'none'
                             CHECK (payment_mode IN ('none', 'before_sign', 'after_sign')),

  created_by                 INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agreement_forms_slug
  ON agreement_forms (LOWER(slug));
CREATE INDEX IF NOT EXISTS idx_agreement_forms_state
  ON agreement_forms (status, published, opens_at, closes_at);
CREATE INDEX IF NOT EXISTS idx_agreement_forms_category
  ON agreement_forms (category);

CREATE TABLE IF NOT EXISTS agreement_fields (
  id             SERIAL PRIMARY KEY,
  agreement_id   INTEGER NOT NULL REFERENCES agreement_forms(id) ON DELETE CASCADE,
  position       INTEGER NOT NULL DEFAULT 0,
  kind           VARCHAR(20) NOT NULL
                 CHECK (kind IN ('text', 'email', 'phone', 'textarea', 'number',
                                 'date', 'select', 'radio', 'checkbox', 'file')),
  field_key      VARCHAR(60) NOT NULL,
  label          VARCHAR(200) NOT NULL,
  placeholder    VARCHAR(200),
  help           TEXT,
  required       BOOLEAN NOT NULL DEFAULT false,
  options        JSONB NOT NULL DEFAULT '[]'::jsonb,
  max_length     INTEGER,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agreement_fields_key
  ON agreement_fields (agreement_id, LOWER(field_key));
CREATE INDEX IF NOT EXISTS idx_agreement_fields_order
  ON agreement_fields (agreement_id, position, id);

-- ---------------------------------------------------------------------------
-- Signed records
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agreement_submissions (
  id                         SERIAL PRIMARY KEY,
  agreement_id               INTEGER NOT NULL REFERENCES agreement_forms(id) ON DELETE RESTRICT,
  user_id                    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reference                  VARCHAR(80) NOT NULL UNIQUE,
  answers                    JSONB NOT NULL DEFAULT '{}'::jsonb,

  signer_name                VARCHAR(200) NOT NULL,
  signer_email               VARCHAR(255),
  signer_type_at_signing     VARCHAR(20) NOT NULL,
  signature_type             VARCHAR(20) NOT NULL
                             CHECK (signature_type IN ('typed', 'drawn')),
  signature_text             TEXT,
  signature_url              TEXT,
  business_signatory_capacity VARCHAR(160),

  guardian_name              VARCHAR(200),
  guardian_email             VARCHAR(255),
  guardian_signature_text    TEXT,
  guardian_signature_url     TEXT,

  witness_name               VARCHAR(200),
  witness_signature          TEXT,
  company_stamp_url          TEXT,

  -- Payment is optional. A paid agreement points into the existing Unplug
  -- payments system once a payment is initiated.
  payment_id                 INTEGER REFERENCES payments(id) ON DELETE SET NULL,
  payment_status             VARCHAR(30) NOT NULL DEFAULT 'not_required'
                             CHECK (payment_status IN ('not_required', 'awaiting_payment',
                                                       'confirmed', 'failed')),

  download_token             VARCHAR(96) NOT NULL UNIQUE,
  document_url               TEXT,
  ip                         TEXT,
  user_agent                 TEXT,
  submitted_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Immutable snapshots. These are the critical protection discovered in the
  -- pre-launch audit: later edits must never rewrite what a past signer agreed
  -- to or what their re-downloaded document displays.
  agreement_version          INTEGER NOT NULL DEFAULT 1,
  title_at_signing           VARCHAR(220) NOT NULL,
  description_at_signing     TEXT,
  rules_at_signing           TEXT,
  terms_at_signing           TEXT,
  post_signing_requirements_at_signing TEXT,
  require_witness_at_signing BOOLEAN NOT NULL DEFAULT false,
  require_company_stamp_at_signing BOOLEAN NOT NULL DEFAULT false,
  amount_at_signing          NUMERIC(10,2),
  payment_mode_at_signing    VARCHAR(20) NOT NULL DEFAULT 'none',
  service_scope_at_signing   VARCHAR(20),
  service_name_at_signing    VARCHAR(200),
  service_description_at_signing TEXT,
  service_reference_at_signing VARCHAR(160),
  client_name_at_signing     VARCHAR(200),
  definition_at_signing      JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_agreement_submissions_agreement
  ON agreement_submissions (agreement_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_agreement_submissions_user
  ON agreement_submissions (user_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_agreement_submissions_payment
  ON agreement_submissions (payment_id);

-- Links from an agreement to an on-site action. `required=true` means that
-- route must enforce the agreement before allowing the target action. The
-- actual gate is deliberately wired per route; there is no unsafe global switch.
CREATE TABLE IF NOT EXISTS agreement_links (
  id                SERIAL PRIMARY KEY,
  agreement_id      INTEGER NOT NULL REFERENCES agreement_forms(id) ON DELETE CASCADE,
  target_type       VARCHAR(80) NOT NULL,
  target_reference  VARCHAR(160),
  route_hint        TEXT,
  required          BOOLEAN NOT NULL DEFAULT false,
  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agreement_links_target
  ON agreement_links (target_type, target_reference);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agreement_links_unique
  ON agreement_links (agreement_id, target_type, COALESCE(target_reference, ''));

-- Every explicit Save in the builder appends a snapshot. Restoring a draft does
-- not overwrite history; it creates a new current state and leaves every older
-- snapshot available.
CREATE TABLE IF NOT EXISTS agreement_draft_versions (
  id                SERIAL PRIMARY KEY,
  agreement_id      INTEGER NOT NULL REFERENCES agreement_forms(id) ON DELETE CASCADE,
  snapshot          JSONB NOT NULL,
  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  restored_from_id  INTEGER REFERENCES agreement_draft_versions(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agreement_drafts_agreement
  ON agreement_draft_versions (agreement_id, created_at DESC, id DESC);

-- Tracks link sends so reminder logic can guarantee an email address is never
-- reminded twice for the same agreement even if the original link was sent
-- more than once.
CREATE TABLE IF NOT EXISTS agreement_sends (
  id                  SERIAL PRIMARY KEY,
  agreement_id        INTEGER NOT NULL REFERENCES agreement_forms(id) ON DELETE CASCADE,
  recipient_email     VARCHAR(255) NOT NULL,
  recipient_name      VARCHAR(200),
  sent_by_user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  sales_consultant_id INTEGER REFERENCES sales_consultants(id) ON DELETE SET NULL,
  sent_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  reminded_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_agreement_sends_lookup
  ON agreement_sends (agreement_id, LOWER(recipient_email), sent_at DESC);

-- Reuses the existing consultant identity system. A grant conveys only the
-- ability to view/share that specific eligible agreement.
CREATE TABLE IF NOT EXISTS agreement_consultant_access (
  id                  SERIAL PRIMARY KEY,
  agreement_id        INTEGER NOT NULL REFERENCES agreement_forms(id) ON DELETE CASCADE,
  sales_consultant_id INTEGER NOT NULL REFERENCES sales_consultants(id) ON DELETE CASCADE,
  granted_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  granted_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agreement_id, sales_consultant_id)
);
CREATE INDEX IF NOT EXISTS idx_agreement_consultant_access_consultant
  ON agreement_consultant_access (sales_consultant_id, agreement_id);

-- ---------------------------------------------------------------------------
-- Existing payment system integration
-- ---------------------------------------------------------------------------
-- Keep the full superset. This constraint is recreated by earlier migrations
-- on every deploy, so 190 must finish with every existing linked_type plus the
-- new agreement type.
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_linked_type_check;
ALTER TABLE payments ADD CONSTRAINT payments_linked_type_check
  CHECK (linked_type IN ('profile_package', 'profile_upgrade', 'competition_entry',
                         'highlight', 'marketplace_listing', 'vote_bundle',
                         'article_publish', 'event_listing', 'gallery_bundle',
                         'top10_entry', 'edition_download', 'ad_banner',
                         'form_payment', 'agreement_payment'));

-- ---------------------------------------------------------------------------
-- Business identity used on generated agreement documents
-- ---------------------------------------------------------------------------
INSERT INTO settings (key, value) VALUES
  ('unplug_business_name', 'Unplug Magazine'),
  ('unplug_business_registration_number', ''),
  ('unplug_business_address', ''),
  ('unplug_business_contact_email', 'info@unplugnews.com')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Starter templates from the preserved design. These are independent starting
-- points only: applying one copies its contents/fields into an agreement.
-- ---------------------------------------------------------------------------
INSERT INTO agreement_templates
  (name, category, title, description, signer_type, rules, terms,
   post_signing_requirements, payment_mode, require_witness,
   require_company_stamp, is_builtin)
VALUES
  ('Photoshoot / Model Release', 'Media & Content', 'Photoshoot / Model Release Agreement',
   'Consent and usage terms for photographs, video and likeness captured for Unplug.',
   'individual', '', '', '', 'none', false, false, true),
  ('Media Partnership', 'Partnerships', 'Media Partnership Agreement',
   'Defines the responsibilities, content rights and deliverables of a media partnership.',
   'business', '', '', '', 'none', false, false, true),
  ('Space / Banner Rental', 'Advertising', 'Space / Banner Rental Agreement',
   'Terms for physical or promotional space and banner placements.',
   'business', '', '', '', 'none', false, false, true),
  ('Freelance Service Agreement', 'Services', 'Freelance Service Agreement',
   'Terms for independent freelance work supplied to or by Unplug.',
   'individual', '', '', '', 'none', false, false, true),
  ('Business Collaboration Agreement', 'Partnerships', 'Business Collaboration Agreement',
   'Defines the scope, responsibilities and rights of a business collaboration.',
   'business', '', '', '', 'none', false, false, true),
  ('Sponsorship Agreement', 'Sponsorship', 'Sponsorship Agreement',
   'Defines sponsorship benefits, obligations, brand use and commercial terms.',
   'business', '', '', '', 'none', false, false, true),
  ('Advertising Agreement', 'Advertising', 'Advertising Agreement',
   'Terms for an advertising campaign, placement or promotional service.',
   'business', '', '', '', 'none', false, false, true),
  ('Event Agreement', 'Events', 'Event Agreement',
   'Terms for event hosting, co-hosting, speaking, vendor or promotional participation.',
   'business', '', '', '', 'none', false, false, true)
ON CONFLICT ((LOWER(name))) DO NOTHING;

-- Seed a small fixed party-information field set for every built-in template.
-- Admin can add, remove or tailor fields after copying a template.
DO $$
DECLARE
  t RECORD;
BEGIN
  FOR t IN SELECT id, signer_type FROM agreement_templates WHERE is_builtin = true LOOP
    IF t.signer_type = 'individual' THEN
      INSERT INTO template_fields
        (template_id, position, kind, field_key, label, required)
      VALUES
        (t.id, 10, 'text',  'full_legal_name', 'Full legal name', true),
        (t.id, 20, 'text',  'id_or_passport',  'ID or passport number', true),
        (t.id, 30, 'text',  'physical_address','Physical address', true),
        (t.id, 40, 'email', 'email',           'Email address', true),
        (t.id, 50, 'phone', 'mobile',          'Mobile number', true),
        (t.id, 60, 'date',  'date_of_birth',   'Date of birth', true)
      ON CONFLICT (template_id, LOWER(field_key)) DO NOTHING;
    ELSE
      INSERT INTO template_fields
        (template_id, position, kind, field_key, label, required)
      VALUES
        (t.id, 10, 'text',  'registered_name', 'Registered company / organisation name', true),
        (t.id, 20, 'text',  'registration_number', 'Registration number', true),
        (t.id, 30, 'text',  'vat_number',      'VAT number (if applicable)', false),
        (t.id, 40, 'text',  'registered_address', 'Registered physical address', true),
        (t.id, 50, 'text',  'signatory_name',  'Authorised representative full name', true),
        (t.id, 60, 'text',  'signatory_capacity', 'Position / capacity', true),
        (t.id, 70, 'email', 'email',            'Authorised representative email', true),
        (t.id, 80, 'phone', 'mobile',           'Authorised representative mobile', true)
      ON CONFLICT (template_id, LOWER(field_key)) DO NOTHING;
    END IF;
  END LOOP;
END $$;
