-- Members can mark individual answers as shareable, on top of the field-level
-- allow_external_sharing ceiling admin sets when building the form (a field
-- admin never marked shareable stays private no matter what the member
-- picks) and the blanket external_sharing_allowed consent already on this
-- table. Stored as one JSONB map (field_key -> boolean) rather than a new
-- table: sparse per-application state with no query pattern beyond "read the
-- whole map for this application", which is the only place it is read.
ALTER TABLE growth_applications
  ADD COLUMN IF NOT EXISTS field_sharing JSONB NOT NULL DEFAULT '{}'::jsonb;
