-- Agreement Forms runtime lifecycle.
-- Adds the short-link and provisional signing-session fields needed for the
-- admin-selected pay-before-sign / sign-before-pay flow.
--
-- A provisional agreement_submissions row is still the payment's linked
-- resource, so the existing payments architecture remains the one source of
-- truth for money. No second checkout/payment table is introduced.

ALTER TABLE agreement_forms
  ADD COLUMN IF NOT EXISTS short_code VARCHAR(24);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agreement_forms_short_code
  ON agreement_forms (LOWER(short_code)) WHERE short_code IS NOT NULL;

ALTER TABLE agreement_submissions
  ADD COLUMN IF NOT EXISTS status VARCHAR(30) NOT NULL DEFAULT 'started',
  ADD COLUMN IF NOT EXISTS signing_token VARCHAR(96),
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS signed_at TIMESTAMPTZ;

-- Provisional rows exist before the actual signature when an agreement is set
-- to pay-before-sign. These fields are populated and frozen only at signing.
ALTER TABLE agreement_submissions ALTER COLUMN signer_name DROP NOT NULL;
ALTER TABLE agreement_submissions ALTER COLUMN signer_type_at_signing DROP NOT NULL;
ALTER TABLE agreement_submissions ALTER COLUMN signature_type DROP NOT NULL;
ALTER TABLE agreement_submissions ALTER COLUMN download_token DROP NOT NULL;
ALTER TABLE agreement_submissions ALTER COLUMN title_at_signing DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_agreement_submissions_signing_token
  ON agreement_submissions (signing_token) WHERE signing_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agreement_submissions_status
  ON agreement_submissions (agreement_id, status, started_at DESC);
