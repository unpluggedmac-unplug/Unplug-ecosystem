-- Member Dashboard article submissions now use articles.body as the short
-- Opening Story / introduction only. Existing and admin-authored articles may
-- still have a longer body, so the database constraint is scoped by a flag
-- that the API controls rather than applied to every historical row.

ALTER TABLE articles
  ADD COLUMN IF NOT EXISTS member_opening_story_limited BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE articles
  DROP CONSTRAINT IF EXISTS articles_member_opening_story_300_chk;

ALTER TABLE articles
  ADD CONSTRAINT articles_member_opening_story_300_chk
  CHECK (
    NOT member_opening_story_limited
    OR char_length(body) <= 300
  );

COMMENT ON COLUMN articles.member_opening_story_limited IS
  'True when body is the member-facing Opening Story introduction and must remain at or below 300 characters.';
