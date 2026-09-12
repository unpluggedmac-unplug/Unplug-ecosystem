-- Agreement member-dashboard visibility (additive, independent of public publication).
-- Public placement remains controlled by published + public_pages.
ALTER TABLE agreement_forms
  ADD COLUMN IF NOT EXISTS member_visible BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS agreement_forms_member_visibility_idx
  ON agreement_forms (status, member_visible, opens_at, closes_at);
