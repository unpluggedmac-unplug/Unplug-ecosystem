-- Cover Image Management + admin-controlled Highlighted Articles.
-- Cover fields already exist and are reused (articles.banner_image_url,
-- profiles.feature_image_url) — this migration only adds what's missing.

-- 1) Highlights: let an admin manually place a highlight with an explicit
--    schedule, display order, and an optional cover image that overrides the
--    target's own image for that placement only.
--    duration_days becomes optional — admin highlights use explicit dates, not
--    a fixed 7/14/21/28 duration. (NULL passes the existing IN(...) CHECK, since
--    a CHECK only fails on FALSE, so no constraint needs dropping.)
ALTER TABLE highlights ALTER COLUMN duration_days DROP NOT NULL;
ALTER TABLE highlights ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 0;
ALTER TABLE highlights ADD COLUMN IF NOT EXISTS admin_image_url TEXT;
ALTER TABLE highlights ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_highlights_priority ON highlights (priority);

-- 2) Top 10: an optional per-ranking cover image the admin can set to override
--    the profile's own feature image for the Top 10 placement.
ALTER TABLE top10_rankings ADD COLUMN IF NOT EXISTS cover_image_url TEXT;
