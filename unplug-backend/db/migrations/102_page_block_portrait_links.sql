-- Portrait image blocks with a clickable image, extending the existing
-- page_blocks CMS (040_page_cms.sql) rather than adding a second, nearly
-- identical block system. Those blocks already carry an image, a
-- description and an optional button; what they could not do is stand
-- portrait, or make the IMAGE ITSELF the link.
--
-- Every column is added with a default that reproduces today's behaviour, so
-- existing blocks render exactly as they do now.

-- Landscape stays the default: every block that exists today was authored
-- against a 16:9 frame, and silently re-cropping them to portrait would
-- damage real pages.
ALTER TABLE page_blocks ADD COLUMN IF NOT EXISTS orientation VARCHAR(10) NOT NULL DEFAULT 'landscape';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'page_blocks_orientation_check') THEN
    ALTER TABLE page_blocks ADD CONSTRAINT page_blocks_orientation_check
      CHECK (orientation IN ('landscape', 'portrait', 'square'));
  END IF;
END $$;

-- Where clicking the image goes. Kept separate from button_url rather than
-- shared: a block can legitimately have a button to one place ("Enquire") and
-- an image linking somewhere else ("View the range"), and collapsing them
-- would make that impossible to express.
ALTER TABLE page_blocks ADD COLUMN IF NOT EXISTS image_link_url TEXT;

-- Whether to print a visible "this image is a link" caption under the image.
--
-- Off by default, because a hint under an image that ISN'T linked would be a
-- lie, and existing blocks have no image link. Worth having at all because a
-- clickable image gives no affordance on touch, where there is no hover
-- cursor to reveal it — on an accessibility-focused site especially, "you can
-- click this" should be readable text rather than something you discover by
-- chance.
ALTER TABLE page_blocks ADD COLUMN IF NOT EXISTS show_click_hint BOOLEAN NOT NULL DEFAULT false;

-- Optional override for that caption. NULL uses the frontend's default
-- wording, so the common case needs no typing and the wording can be
-- improved in one place later.
ALTER TABLE page_blocks ADD COLUMN IF NOT EXISTS click_hint_text VARCHAR(160);
