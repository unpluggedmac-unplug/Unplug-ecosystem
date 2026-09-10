-- Small Agreement Forms definition fields called out by the preserved design
-- but intentionally kept separate from the core 190 migration for reviewability.

ALTER TABLE agreement_forms
  ADD COLUMN IF NOT EXISTS how_it_works JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS reminder_days INTEGER;

ALTER TABLE agreement_templates
  ADD COLUMN IF NOT EXISTS how_it_works JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS reminder_days INTEGER;
