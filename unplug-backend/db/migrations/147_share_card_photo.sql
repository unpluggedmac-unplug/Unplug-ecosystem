-- A photograph on the share card, and where it sits in its circle.
--
-- THE PHOTO NEEDS A MEMBER ACCOUNT; the card itself still does not.
--
-- Anybody featured in the magazine can still make a card without signing up —
-- that has always been true and breaking it would put a login in front of
-- somebody at the exact moment they are most pleased with us. What requires an
-- account is ADDING A PICTURE, because an unauthenticated upload that becomes
-- a publicly readable file is free image hosting for anyone who finds the
-- endpoint, and there is no account to suspend when it is abused.
--
-- So a card with no photo shows the gold U monogram, exactly as the design
-- does when the circle is empty, and the form invites signing in to add one.
--
-- WHY THE POSITION IS STORED and not just the file: almost no photograph is
-- square. The person drags and zooms until their face sits properly in the
-- circle, and if only the URL were kept, the approved card emailed to them
-- would be a centre crop of the same picture — which is how you send somebody
-- a card with the top of their head missing. These three numbers are what make
-- the approved card identical to the one they signed off.
--
-- Reversal: drop the four columns. Cards fall back to the monogram and
-- everything else is unchanged.

ALTER TABLE share_cards ADD COLUMN IF NOT EXISTS photo_url TEXT;

-- Offsets are a FRACTION of the circle's diameter rather than pixels, so the
-- same values render correctly whether the card is drawn at 1080px for a
-- download or at 400px in a preview. Pixels would have meant the picture
-- jumping when the canvas size changed.
ALTER TABLE share_cards ADD COLUMN IF NOT EXISTS photo_offset_x NUMERIC(5,3) NOT NULL DEFAULT 0;
ALTER TABLE share_cards ADD COLUMN IF NOT EXISTS photo_offset_y NUMERIC(5,3) NOT NULL DEFAULT 0;

-- 1.0 means the photo exactly covers the circle. Bounded in the application
-- as well; the CHECK is here so a value that would render as a hairline or a
-- single pixel of forehead cannot be stored at all.
ALTER TABLE share_cards ADD COLUMN IF NOT EXISTS photo_zoom NUMERIC(4,2) NOT NULL DEFAULT 1;

DO $$
BEGIN
  ALTER TABLE share_cards ADD CONSTRAINT share_cards_photo_zoom_sane
    CHECK (photo_zoom >= 1 AND photo_zoom <= 4);
EXCEPTION
  -- Every migration here re-runs on every deploy, and adding a constraint that
  -- already exists is an error rather than a no-op.
  WHEN duplicate_object THEN NULL;
END $$;

-- Who uploaded it. Not required — cards made before this, and cards with no
-- photo, have none — but it is the only way to answer "who put this picture on
-- our masthead" if one ever has to be answered.
ALTER TABLE share_cards ADD COLUMN IF NOT EXISTS photo_user_id INTEGER
  REFERENCES users(id) ON DELETE SET NULL;
