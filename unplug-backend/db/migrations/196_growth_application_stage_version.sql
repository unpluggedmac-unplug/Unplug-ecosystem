-- Preserve which Quick Profile / Growth Assessment schema a draft was created against.
-- Deep Discovery has its own independent question_bank_version column from migration 195.

ALTER TABLE growth_applications
  ADD COLUMN IF NOT EXISTS stage_schema_version VARCHAR(120) NOT NULL DEFAULT '2026-09-11-intake-v1';

CREATE INDEX IF NOT EXISTS idx_growth_applications_schema_versions
  ON growth_applications(stage_schema_version, question_bank_version);
