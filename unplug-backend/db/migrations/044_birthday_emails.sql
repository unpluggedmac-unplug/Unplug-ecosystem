-- Birthday greetings by email.

-- Nullable in the database even though the public form now requires it:
-- existing rows have no address, and making the column NOT NULL would fail
-- the migration on a live table. The API enforces it for new submissions.
ALTER TABLE birthdays ADD COLUMN IF NOT EXISTS email VARCHAR(255);

-- Which greetings have already gone out. Keyed by (birthday, year) so the
-- sender can run as often as it likes — several times a day, or twice after
-- a restart — and still only ever send one greeting per person per year.
-- That matters more than usual here: a duplicate birthday email is the kind
-- of small embarrassment people remember.
CREATE TABLE IF NOT EXISTS birthday_emails_sent (
  birthday_id INTEGER NOT NULL REFERENCES birthdays(id) ON DELETE CASCADE,
  sent_year   INTEGER NOT NULL,
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (birthday_id, sent_year)
);

CREATE INDEX IF NOT EXISTS birthday_emails_sent_year_idx
  ON birthday_emails_sent (sent_year);
