-- Part 3 of "admin control over banner/cover animation effects": a hover/
-- focus-revealed entrance effect on article, edition, and directory-profile
-- cover images — the one thing this whole feature isn't extending, since
-- these covers have NO animation of any kind today (.story-thumb,
-- .edition-cover, .dir-photo are static gradient boxes). Reuses the same
-- 8-value enum every other part uses.
--
-- No display_duration_ms column here, unlike Ad Banners/Marketplace: a hover
-- effect has no "how long it stays up" — it plays on hover-in and reverses
-- on hover-out, so there's nothing to schedule.
--
-- Default 'none' means nothing already published gains an effect the moment
-- this migration runs — only a cover an admin actually opts in shows one.
ALTER TABLE articles
  ADD COLUMN IF NOT EXISTS cover_animation_effect VARCHAR(20) NOT NULL DEFAULT 'none'
    CHECK (cover_animation_effect IN ('none','fade','fade-up','slide-up','slide-down','slide-left','slide-right','zoom')),
  ADD COLUMN IF NOT EXISTS cover_transition_duration_ms INTEGER NOT NULL DEFAULT 400
    CHECK (cover_transition_duration_ms > 0 AND cover_transition_duration_ms <= 10000);

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS cover_animation_effect VARCHAR(20) NOT NULL DEFAULT 'none'
    CHECK (cover_animation_effect IN ('none','fade','fade-up','slide-up','slide-down','slide-left','slide-right','zoom')),
  ADD COLUMN IF NOT EXISTS cover_transition_duration_ms INTEGER NOT NULL DEFAULT 400
    CHECK (cover_transition_duration_ms > 0 AND cover_transition_duration_ms <= 10000);

ALTER TABLE editions
  ADD COLUMN IF NOT EXISTS cover_animation_effect VARCHAR(20) NOT NULL DEFAULT 'none'
    CHECK (cover_animation_effect IN ('none','fade','fade-up','slide-up','slide-down','slide-left','slide-right','zoom')),
  ADD COLUMN IF NOT EXISTS cover_transition_duration_ms INTEGER NOT NULL DEFAULT 400
    CHECK (cover_transition_duration_ms > 0 AND cover_transition_duration_ms <= 10000);
