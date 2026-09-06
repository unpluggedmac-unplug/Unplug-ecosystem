-- Ad slots: support several rotating banners per placement instead of
-- exactly one. The table previously had slot_key as its PRIMARY KEY (one
-- banner per slot); that's dropped in favour of a plain id, so multiple
-- banners can share a slot_key and rotate on the public page.
--
-- IMPORTANT: this migration is re-run on every backend start. Phase 9 later
-- adds ad_banner_analytics with a foreign key to ad_slots(id), so blindly
-- dropping ad_slots_pkey on every run would fail once that FK exists. Only
-- replace the primary key when it is not already the id key.
ALTER TABLE ad_slots ADD COLUMN IF NOT EXISTS id SERIAL;

DO $$
DECLARE
  current_pk_name TEXT;
  current_pk_columns TEXT[];
BEGIN
  SELECT c.conname,
         array_agg(a.attname ORDER BY k.ord)
    INTO current_pk_name, current_pk_columns
    FROM pg_constraint c
    CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_attribute a
      ON a.attrelid = c.conrelid
     AND a.attnum = k.attnum
   WHERE c.conrelid = 'ad_slots'::regclass
     AND c.contype = 'p'
   GROUP BY c.conname;

  IF current_pk_columns IS NULL THEN
    ALTER TABLE ad_slots ADD PRIMARY KEY (id);
  ELSIF current_pk_columns <> ARRAY['id']::TEXT[] THEN
    EXECUTE format('ALTER TABLE ad_slots DROP CONSTRAINT %I', current_pk_name);
    ALTER TABLE ad_slots ADD PRIMARY KEY (id);
  END IF;
END $$;

ALTER TABLE ad_slots ADD COLUMN IF NOT EXISTS display_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ad_slots ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE ad_slots ADD COLUMN IF NOT EXISTS starts_at DATE;
ALTER TABLE ad_slots ADD COLUMN IF NOT EXISTS ends_at DATE;
ALTER TABLE ad_slots ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_ad_slots_slot_key ON ad_slots (slot_key);
