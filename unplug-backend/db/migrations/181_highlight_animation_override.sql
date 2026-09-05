-- Part 4 of "admin control over banner/cover animation effects": a per-
-- placement OVERRIDE of a Highlighted Article's entrance effect/speed,
-- mirroring the exact relationship `admin_image_url` already has to
-- `articles.banner_image_url` on this same table (056_cover_images_
-- highlights.sql) — NULL here means "use the article's own
-- cover_animation_effect/cover_transition_duration_ms" (from
-- 180_cover_animation.sql); a non-null value overrides it for this
-- placement only.
--
-- Nullable, unlike every other part of this feature — the override itself
-- needs "unset" as a real, meaningful state, not a default value. No
-- display_duration_ms either: the public "Featured Stories" slider is
-- manually swiped, not auto-rotating, so the effect plays once per reveal,
-- with nothing to schedule.
ALTER TABLE highlights
  ADD COLUMN IF NOT EXISTS animation_effect VARCHAR(20)
    CHECK (animation_effect IS NULL OR animation_effect IN ('none','fade','fade-up','slide-up','slide-down','slide-left','slide-right','zoom')),
  ADD COLUMN IF NOT EXISTS transition_duration_ms INTEGER
    CHECK (transition_duration_ms IS NULL OR (transition_duration_ms > 0 AND transition_duration_ms <= 10000));
