-- Part 1 of "admin control over banner/cover animation effects": let an
-- admin pick which entrance effect plays for each ad banner, and both how
-- long that effect takes and how long the banner stays up before the
-- rotation advances to the next one.
--
-- Reuses the exact 8-value enum unplug-popups.js already validates for its
-- own entrance-animation dropdown (ALLOWED_ANIM), so there is one vocabulary
-- of effect names across the whole site rather than a second one invented
-- here.
--
-- Defaults reproduce TODAY'S exact hardcoded behaviour — .ad-slide's
-- crossfade (transition:opacity 0.6s ease) and the rotation's
-- setInterval(...,5000) — so no existing banner changes appearance the
-- moment this migration runs. Only a banner an admin actually edits picks up
-- a different look.
ALTER TABLE ad_slots
  ADD COLUMN IF NOT EXISTS animation_effect VARCHAR(20) NOT NULL DEFAULT 'fade'
    CHECK (animation_effect IN ('none','fade','fade-up','slide-up','slide-down','slide-left','slide-right','zoom')),
  ADD COLUMN IF NOT EXISTS transition_duration_ms INTEGER NOT NULL DEFAULT 600
    CHECK (transition_duration_ms > 0 AND transition_duration_ms <= 10000),
  ADD COLUMN IF NOT EXISTS display_duration_ms INTEGER NOT NULL DEFAULT 5000
    CHECK (display_duration_ms >= 1000 AND display_duration_ms <= 120000);
