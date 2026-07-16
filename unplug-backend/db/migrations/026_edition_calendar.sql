-- Editions "Save the Date" calendar. Admins mark upcoming days that matter
-- for editions (submission deadlines, release dates, etc.); those days show
-- red with a "SAVE THE DATE" label + title on the public Editions page, and
-- clicking one reveals the full description.
CREATE TABLE IF NOT EXISTS edition_calendar (
  id          SERIAL PRIMARY KEY,
  event_date  DATE NOT NULL,
  title       VARCHAR(255) NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_edition_calendar_date ON edition_calendar (event_date);
