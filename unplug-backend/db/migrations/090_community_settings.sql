-- Members, Profile Social Interaction & Community System — Phase 8:
-- Admin Management — feature toggles.
--
-- Reuses the existing generic `settings` key/value table
-- (008_settings_bundle_vote.sql) and its existing GET/PATCH
-- /admin/settings routes — confirmed both already exist, fully generic,
-- before building anything new. No new table, no new generic-settings
-- routes; only the seed rows and the enforcement checks that read them
-- are new.
INSERT INTO settings (key, value) VALUES
  ('community_likes_enabled', 'true'),
  ('community_dislikes_enabled', 'true'),
  ('community_comments_enabled', 'true'),
  ('community_saves_enabled', 'true'),
  ('community_reviews_enabled', 'true'),
  ('community_follow_enabled', 'true'),
  ('community_unfollow_enabled', 'true')
ON CONFLICT (key) DO NOTHING;
