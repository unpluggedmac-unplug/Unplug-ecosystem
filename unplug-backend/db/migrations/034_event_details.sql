-- Richer event details for the homepage calendar: a feature image, the
-- attendee entrance fee (display text like "R50" / "Free"), organizer
-- contact + a link, and start/end times (used for the time display and the
-- add-to-calendar links).
ALTER TABLE events ADD COLUMN IF NOT EXISTS image_url       TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS entrance_fee    VARCHAR(80);
ALTER TABLE events ADD COLUMN IF NOT EXISTS contact_details VARCHAR(255);
ALTER TABLE events ADD COLUMN IF NOT EXISTS event_link      TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS start_time      TIME;
ALTER TABLE events ADD COLUMN IF NOT EXISTS end_time        TIME;
