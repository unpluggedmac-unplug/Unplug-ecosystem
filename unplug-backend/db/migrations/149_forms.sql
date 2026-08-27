-- The form builder: forms an admin composes, without a deploy.
--
-- WHAT THIS IS NOT. It is not a second contact form and not a second enquiry
-- inbox. The contact form, the newsletter box and the nomination form stay
-- exactly where they are — they are load-bearing and they work. This is for
-- the forms that do not exist yet: a bursary application, a survey, an event
-- RSVP, a call for submissions that runs for six weeks and then stops.
--
-- IT REUSES EVERYTHING. Spam scoring, the honeypot, the rate limiter, CRM
-- capture and the admin notification are all already built and are wired to
-- this rather than reimplemented. The only genuinely new things here are the
-- definition of a form and the answers people give.

-- ---------------------------------------------------------------------------
-- The form
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS forms (
  id           SERIAL PRIMARY KEY,
  name         VARCHAR(160) NOT NULL,       -- internal; what the admin calls it
  slug         VARCHAR(80) NOT NULL,        -- the address: /form/<slug>
  title        VARCHAR(200) NOT NULL,       -- the heading a reader sees
  intro        TEXT,
  success_message TEXT,

  -- OFF UNTIL SWITCHED ON, the same rule as popups, automations and social
  -- posts. A form half-built on a Tuesday must not be collecting real answers
  -- from real people on Wednesday.
  active       BOOLEAN NOT NULL DEFAULT false,

  -- A form can stop on its own. A bursary that closed in March should say so
  -- rather than quietly keep taking applications nobody will read.
  opens_at     TIMESTAMPTZ,
  closes_at    TIMESTAMPTZ,
  closed_message TEXT,

  -- What a submission costs, in rand. NULL or 0 means free, which is the
  -- normal case. A paid form creates a real row in `payments` and goes through
  -- the portal that already exists — one place where money is handled.
  amount       NUMERIC(10,2),

  -- Where to tell somebody a submission arrived. Empty falls back to the
  -- normal admin notification, which everybody already sees.
  notify_email VARCHAR(255),

  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_forms_slug ON forms (LOWER(slug));
CREATE INDEX IF NOT EXISTS idx_forms_live ON forms (active, opens_at, closes_at);

-- ---------------------------------------------------------------------------
-- The fields
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS form_fields (
  id        SERIAL PRIMARY KEY,
  form_id   INTEGER NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  position  INTEGER NOT NULL,

  kind      VARCHAR(20) NOT NULL
            CHECK (kind IN ('text', 'email', 'phone', 'textarea', 'number',
                            'date', 'select', 'radio', 'checkbox', 'file')),

  -- The stable key an answer is stored against. NOT the label: renaming
  -- "Your school" to "School attended" must not orphan every answer already
  -- collected under the old wording.
  field_key VARCHAR(60) NOT NULL,

  label       VARCHAR(200) NOT NULL,
  placeholder VARCHAR(200),
  help        TEXT,
  required    BOOLEAN NOT NULL DEFAULT false,

  -- For select and radio. Ignored by every other kind.
  options   JSONB NOT NULL DEFAULT '[]',

  max_length INTEGER,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_form_fields_key ON form_fields (form_id, LOWER(field_key));
CREATE INDEX IF NOT EXISTS idx_form_fields_order ON form_fields (form_id, position);

-- ---------------------------------------------------------------------------
-- The answers
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS form_submissions (
  id        SERIAL PRIMARY KEY,
  form_id   INTEGER NOT NULL REFERENCES forms(id) ON DELETE CASCADE,

  -- Keyed by field_key, so the answers survive a label being reworded and can
  -- still be read years later against the fields as they were.
  answers   JSONB NOT NULL DEFAULT '{}',

  -- Lifted out of the answers when a field of that kind exists, because these
  -- two are what everything else wants to join on — the CRM, the export, the
  -- "who submitted this" question.
  email     VARCHAR(255),
  full_name VARCHAR(200),

  user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,

  -- A paid form's submission points at the real payments row. Kept NULL for a
  -- free form rather than inventing a zero-rand payment: a row in `payments`
  -- means money was actually expected.
  payment_id INTEGER REFERENCES payments(id) ON DELETE SET NULL,

  status    VARCHAR(20) NOT NULL DEFAULT 'new'
            CHECK (status IN ('new', 'read', 'actioned', 'archived')),

  ip        TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_form_subs_form ON form_submissions (form_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_form_subs_status ON form_submissions (form_id, status);

-- ---------------------------------------------------------------------------
-- Letting a payment belong to a form
-- ---------------------------------------------------------------------------
--
-- THE WHOLE LIST HAS TO BE RESTATED, and that is the dangerous part of this
-- file. payments_linked_type_check is not added to — it is dropped and
-- rebuilt, most recently in 060_self_serve_banners.sql. Every value below
-- comes from that definition; leaving one out would not fail here, it would
-- fail later, the first time somebody bought whichever service was forgotten.
--
-- This migration has a higher number than 060, so it runs last and its
-- definition is the one that survives. Anything that redefines this constraint
-- in future must copy this list forward, including 'form_payment'.
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_linked_type_check;
ALTER TABLE payments ADD CONSTRAINT payments_linked_type_check
  CHECK (linked_type IN ('profile_package', 'profile_upgrade', 'competition_entry',
                         'highlight', 'marketplace_listing', 'vote_bundle',
                         'article_publish', 'event_listing', 'gallery_bundle',
                         'top10_entry', 'edition_download', 'ad_banner',
                         'form_payment'));
