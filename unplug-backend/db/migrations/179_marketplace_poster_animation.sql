-- Part 2 of "admin control over banner/cover animation effects": the same
-- per-item entrance effect / speed / display duration as Ad Banners
-- (178_ad_banner_animation.sql), applied to the Marketplace poster carousel.
--
-- The poster carousel's current look has NO extra entrance effect layered on
-- top of the track's own translateX slide (see setupPosterCarousel in
-- unplug-magazine.html) — only the track's own 0.5s transform transition and
-- a fixed 4-second rotation. Default 'none' preserves that exactly;
-- transition_duration_ms seeds 500 to match the track's own speed for
-- whenever an admin turns an entrance effect on for a specific listing.
ALTER TABLE marketplace_listings
  ADD COLUMN IF NOT EXISTS animation_effect VARCHAR(20) NOT NULL DEFAULT 'none'
    CHECK (animation_effect IN ('none','fade','fade-up','slide-up','slide-down','slide-left','slide-right','zoom')),
  ADD COLUMN IF NOT EXISTS transition_duration_ms INTEGER NOT NULL DEFAULT 500
    CHECK (transition_duration_ms > 0 AND transition_duration_ms <= 10000),
  ADD COLUMN IF NOT EXISTS display_duration_ms INTEGER NOT NULL DEFAULT 4000
    CHECK (display_duration_ms >= 1000 AND display_duration_ms <= 120000);
