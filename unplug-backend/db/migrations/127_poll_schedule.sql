-- A poll can run for a set period instead of until somebody remembers to
-- close it.
--
-- Both dates are NULLABLE and NULL means "no restriction on that side", which
-- is what keeps every poll that already exists behaving exactly as it does
-- today: no start, no end, open until an admin closes it by hand. Nothing
-- currently running changes.
--
--   starts_at  the poll does not accept votes before this date
--   ends_at    the poll stops accepting votes AFTER this date
--
-- ends_at is INCLUSIVE. A poll ending on the 7th accepts votes all through
-- the 7th. Somebody told a poll runs "until the 7th" and finding it shut on
-- the morning of the 7th has been given a day less than they were promised.
--
-- is_open IS KEPT and still wins. The dates are a schedule; is_open is the
-- switch. An admin closing a poll early must not have it reopened by its own
-- end date still being in the future, so voting requires BOTH: is_open true
-- AND inside the window. That also means "reopen" on a poll whose end date
-- has passed will not actually reopen it, which is why the admin screen shows
-- the effective state rather than just the flag.
ALTER TABLE polls ADD COLUMN IF NOT EXISTS starts_at DATE;
ALTER TABLE polls ADD COLUMN IF NOT EXISTS ends_at   DATE;

-- The article page asks "is there a poll for this article", and the admin
-- list orders by date. Both benefit from the window being indexed.
CREATE INDEX IF NOT EXISTS polls_schedule_idx ON polls (article_id, starts_at, ends_at);
