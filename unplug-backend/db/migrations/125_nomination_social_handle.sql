-- Nominations can carry the nominee's social handle or page link.
--
-- The whole point of this page is that the people worth writing about would
-- never put themselves forward — so whoever nominates them is often the only
-- person who can say where to find them. Without this the desk had a name and
-- nothing else, and common South African names are not searchable.
--
-- TWO COLUMNS, ON PURPOSE:
--
--   nominee_social      exactly what the nominator typed. Never rewritten, so
--                       "@thandi.m" stays "@thandi.m" and the desk can see
--                       what they were actually given.
--   nominee_social_url  a safe https:// link, but only when one can honestly
--                       be built from the text. A bare handle leaves this
--                       NULL, because guessing a platform would send the desk
--                       to the wrong person's page.
--
-- The admin screen makes it a clickable link when the URL is there and shows
-- plain text when it is not, so nothing has to be guessed at read time either.
ALTER TABLE shoutout_nominations
  ADD COLUMN IF NOT EXISTS nominee_social     VARCHAR(200);
ALTER TABLE shoutout_nominations
  ADD COLUMN IF NOT EXISTS nominee_social_url VARCHAR(300);
