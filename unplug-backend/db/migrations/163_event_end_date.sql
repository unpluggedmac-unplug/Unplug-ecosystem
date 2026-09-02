-- An event that runs for more than one day disappeared part-way through it.
--
-- events carried event_date, start_time and end_time, but no END DATE. The
-- public feed asked:
--
--   status = 'approved' AND event_date >= CURRENT_DATE
--
-- so a festival running Friday to Sunday, with one event_date of Friday, was
-- removed from the site on Saturday morning — while it was still running, and
-- while it was still selling tickets. Anything lasting more than a day vanished
-- part-way through.
--
-- start_time and end_time did not help: they are times of day, not dates, so
-- they say when Friday's programme begins and ends, not that the event runs
-- until Sunday.
--
-- WHY A SEPARATE COLUMN AND NOT A CHANGE TO event_date
--
-- event_date means "when this starts" everywhere it is read — it orders the
-- calendar, it is what an admin types, and it is what the card shows. Widening
-- it to mean "when this ends" would have quietly changed the order of the
-- homepage and the meaning of every existing row. A second column adds meaning
-- without taking any away.
--
-- NULL MEANS ONE DAY, which is what every existing row is, so nothing has to be
-- backfilled and nothing changes for a single-day event.
--
-- WHY THE CHECK IS SAFE TO RE-ADD ON EVERY DEPLOY
--
-- Migrations run on every deploy and a CHECK is re-validated against the whole
-- table each time. This one passes for every row that could already exist:
-- end_date is NULL on all of them, and NULL satisfies the condition. It only
-- ever refuses a NEW row that claims to end before it starts.

ALTER TABLE events ADD COLUMN IF NOT EXISTS end_date DATE;

COMMENT ON COLUMN events.end_date IS
  'Last day of a multi-day event. NULL means it runs for the one day in event_date.';

ALTER TABLE events DROP CONSTRAINT IF EXISTS events_end_date_check;
ALTER TABLE events ADD CONSTRAINT events_end_date_check
  CHECK (end_date IS NULL OR end_date >= event_date);

-- The public feed now filters on COALESCE(end_date, event_date), so that is
-- what needs to be indexed rather than event_date alone.
CREATE INDEX IF NOT EXISTS idx_events_runs_until
  ON events (status, (COALESCE(end_date, event_date)));
