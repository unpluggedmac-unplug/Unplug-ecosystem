-- The public "sign this agreement" button (currently rendered on the checkout
-- page, see GET /agreement-forms?page=X) always said the same fixed text
-- ("View & sign agreement"). Admin now controls what it actually says per
-- agreement — e.g. "Sponsor Our Homepage" reads better than a generic label
-- for a sponsorship deal. Falls back to the old fixed text when blank so
-- every existing agreement keeps behaving exactly as it already does.
ALTER TABLE agreement_forms
  ADD COLUMN IF NOT EXISTS button_label VARCHAR(80);
