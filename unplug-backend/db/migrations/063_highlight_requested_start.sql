-- Homepage profile highlighting: let a member choose a FUTURE start date when
-- buying a highlight, instead of every paid highlight starting the day the
-- payment clears.
--
-- Extends the existing `highlights` table (created in 006, extended in 056 with
-- priority/admin_image_url/is_admin) — no second promotional system. Nullable
-- with no default, so it's a metadata-only change that cannot fail on existing
-- rows: an existing highlight with no requested_start_date simply keeps the old
-- "starts today" behaviour.
ALTER TABLE highlights ADD COLUMN IF NOT EXISTS requested_start_date DATE;
