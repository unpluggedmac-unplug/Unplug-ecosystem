-- Ad slots: support several rotating banners per placement instead of
-- exactly one. The table previously had slot_key as its PRIMARY KEY (one
-- banner per slot); that's dropped in favour of a plain id, so multiple
-- banners can share a slot_key and rotate on the public page. No live
-- banners exist yet in any deployed environment, so there's nothing to
-- carry forward, but this still uses IF NOT EXISTS / conditional drops
-- throughout so it's safe to run again.
ALTER TABLE ad_slots ADD COLUMN IF NOT EXISTS id SERIAL;
ALTER TABLE ad_slots DROP CONSTRAINT IF EXISTS ad_slots_pkey;
ALTER TABLE ad_slots ADD PRIMARY KEY (id);
ALTER TABLE ad_slots ADD COLUMN IF NOT EXISTS display_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ad_slots ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE ad_slots ADD COLUMN IF NOT EXISTS starts_at DATE;
ALTER TABLE ad_slots ADD COLUMN IF NOT EXISTS ends_at DATE;
ALTER TABLE ad_slots ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_ad_slots_slot_key ON ad_slots (slot_key);
