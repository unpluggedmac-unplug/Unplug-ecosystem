-- An article can carry a video, added by pasting one link.
--
-- Four columns rather than one, because the link a person pastes and the
-- address that goes in a frame are not the same thing and must not be
-- confused:
--
--   video_url        exactly what was pasted. Kept so an editor can see what
--                    the writer meant, and so a link can be re-parsed later
--                    if a platform changes its embed format.
--   video_platform   youtube | tiktok | instagram | gdrive
--   video_embed_url  the player address WE construct from the video id. This
--                    is the ONLY value that is ever put in an iframe. Nothing
--                    a person typed reaches a frame src directly.
--   video_thumbnail_url
--                    a real preview image where the platform publishes one
--                    without an API key, which today is YouTube alone. NULL
--                    everywhere else, and the page shows a branded play panel
--                    instead. Nobody is asked to choose a cover image.
--
-- All nullable: an article without a video is the normal case and nothing
-- about existing articles changes.
ALTER TABLE articles ADD COLUMN IF NOT EXISTS video_url           TEXT;
ALTER TABLE articles ADD COLUMN IF NOT EXISTS video_platform      VARCHAR(20);
ALTER TABLE articles ADD COLUMN IF NOT EXISTS video_embed_url     TEXT;
ALTER TABLE articles ADD COLUMN IF NOT EXISTS video_thumbnail_url TEXT;

-- Constrained rather than free text, so a typo in code cannot invent a
-- platform the front end has no way to render.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'articles_video_platform_check'
  ) THEN
    ALTER TABLE articles ADD CONSTRAINT articles_video_platform_check
      CHECK (video_platform IS NULL
             OR video_platform IN ('youtube', 'tiktok', 'instagram', 'gdrive'));
  END IF;
END;
$$;
