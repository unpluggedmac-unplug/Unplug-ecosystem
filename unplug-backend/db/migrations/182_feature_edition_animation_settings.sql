-- Part 5 of "admin control over banner/cover animation effects": the
-- homepage Feature Edition image — the one surface in this feature with no
-- table row behind it at all (a single CMS-swappable image, not a database
-- row), so its two values live in the existing generic settings key/value
-- table, exactly like youtube_image_url.
--
-- Seeded to reproduce TODAY'S exact hardcoded Ken Burns pan
-- (transform:scale(1.18); animation:featureZoomOut 24s ease-out both;) so
-- nothing changes visually until an admin picks something else. 'zoom' here
-- is interpreted specially by the frontend as "play the existing slow
-- featureZoomOut keyframe" — this image's effect is a continuous 24-second
-- pan, structurally different from the fast (~300-600ms) entrance effects
-- every other part of this feature uses, so it keeps its own bespoke
-- keyframe rather than folding into the shared library.
INSERT INTO settings (key, value) VALUES
  ('feature_edition_animation_effect', 'zoom'),
  ('feature_edition_transition_duration_ms', '24000')
ON CONFLICT (key) DO NOTHING;
