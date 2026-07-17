-- Admin-choosable image for the homepage "Watch on YouTube" section.
-- Stored as a normal setting; empty by default (frontend falls back to the
-- embedded playlist when unset).
INSERT INTO settings (key, value) VALUES ('youtube_image_url', '')
ON CONFLICT (key) DO NOTHING;
