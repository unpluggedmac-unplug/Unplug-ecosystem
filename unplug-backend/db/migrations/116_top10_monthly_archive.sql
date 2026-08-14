-- TOP 10 MONTHLY RANKINGS — capture each month's final board, then start the
-- next month from zero without destroying anything.
--
-- THE RULE THIS IMPLEMENTS
--   At the end of every month the full Top 10 is captured (#1 down to the last
--   place) with each contestant's vote total. The new month then starts every
--   contestant back at zero — but they KEEP THEIR POSITION from the month just
--   ended until new votes move them. Admin keeps a permanent record of every
--   past month.
--
-- WHY THE VOTES ARE NOT DELETED
--   votes.payment_id and votes.vote_bundle_id tie vote rows to real money:
--   bulk vote purchases are payments. Deleting votes each month would destroy
--   the only record of what a buyer paid for, so a purchase queried three
--   months later could not be answered. Instead every vote is STAMPED with the
--   month it belongs to, and the leaderboard counts one month at a time. The
--   "reset" is then simply the calendar turning over: on the 1st, no vote
--   carries the new month's stamp yet, so every total reads zero — while every
--   paid vote is still on file, attached to its payment, for ever.
--
--   This also makes the month-end job impossible to miss. Because the votes
--   themselves carry the period, a capture that runs late (the Render instance
--   sleeps when idle, so 23:59 exactly is not guaranteed) still computes the
--   correct final board for the month that ended. Nothing is lost by being
--   late; the numbers are not going anywhere.

-- ---------------------------------------------------------------------------
-- 1. Which month each vote counts toward.
-- ---------------------------------------------------------------------------

-- Added WITHOUT a default first. Postgres fills existing rows with a volatile
-- DEFAULT at ALTER time, which would silently decide the backfill for us
-- before the deliberate UPDATE below gets a say.
ALTER TABLE votes ADD COLUMN IF NOT EXISTS vote_period DATE;

-- THE BACKFILL IS DELIBERATELY "THIS MONTH", NOT created_at.
--
-- Every vote cast until now counted toward one running all-time total, which
-- is what the live board is showing contestants today. Stamping old votes by
-- their created_at would drop months of votes off the board the instant this
-- deploys — a mid-month reset nobody asked for, on a public leaderboard, with
-- contestants watching. Treating the existing votes as belonging to the month
-- now in progress keeps today's board exactly as it stands. The first real
-- reset then happens where it should: at the first month end after this ships.
UPDATE votes
   SET vote_period = date_trunc('month', (now() AT TIME ZONE 'Africa/Johannesburg'))::date
 WHERE vote_period IS NULL;

-- Now the default, for every vote cast from here on. South African month, not
-- UTC, so the month rolls over at local midnight rather than 02:00 SAST — the
-- same reasoning as vote_day in 098. This is set AFTER the backfill so it
-- applies only to new rows, and it means none of the four INSERT sites
-- (free vote, admin adjustment, bundle approval, online paid vote) has to
-- remember to stamp it.
ALTER TABLE votes
  ALTER COLUMN vote_period
  SET DEFAULT (date_trunc('month', (now() AT TIME ZONE 'Africa/Johannesburg')))::date;

-- Safe now that every row is filled and every future row gets the default. A
-- NULL here would be a vote belonging to no month, invisible on every board.
ALTER TABLE votes ALTER COLUMN vote_period SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_votes_entry_period ON votes (entry_id, vote_period);

-- ---------------------------------------------------------------------------
-- 2. The position a contestant carries into the new month.
-- ---------------------------------------------------------------------------

-- Set at capture time to the place the entry finished. It is a TIE-BREAKER,
-- never a score: the board still orders on this month's votes first, so one
-- real vote beats any carried position. It only decides the order among
-- contestants who are level — which, on the 1st of the month, is everyone.
-- That is what "restart at zero but stay in position" means in practice.
--
-- NULL = has never been captured (a brand new entry), which sorts last among
-- equals rather than jumping the queue ahead of last month's champion.
ALTER TABLE competition_entries ADD COLUMN IF NOT EXISTS carried_rank INTEGER;

-- ---------------------------------------------------------------------------
-- 3. The archive itself — one row per contestant per month, for ever.
-- ---------------------------------------------------------------------------

-- display_name, entry_code, category and image_url are DENORMALISED on
-- purpose. This is a historical record: it has to still read correctly in two
-- years when the entry has been deleted, the profile renamed, or the listing
-- taken down. A record of who won August that goes blank because someone
-- tidied up a profile is not a record.
--
-- Both foreign keys are ON DELETE SET NULL for the same reason. The earlier
-- top10_rankings.profile_id is a hard reference and a deleted profile makes
-- publishing fail outright; history must never be that fragile.
CREATE TABLE IF NOT EXISTS top10_monthly_rankings (
  id            SERIAL PRIMARY KEY,
  period_year   INTEGER NOT NULL,
  period_month  INTEGER NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  rank          INTEGER NOT NULL,
  entry_id      INTEGER REFERENCES competition_entries(id) ON DELETE SET NULL,
  profile_id    INTEGER REFERENCES profiles(id) ON DELETE SET NULL,
  display_name  TEXT NOT NULL,
  entry_code    TEXT,
  category      TEXT,
  image_url     TEXT,
  profile_slug  TEXT,
  vote_count    INTEGER NOT NULL DEFAULT 0,
  captured_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (period_year, period_month, rank)
);

CREATE INDEX IF NOT EXISTS idx_top10_monthly_period
  ON top10_monthly_rankings (period_year DESC, period_month DESC, rank ASC);

-- ---------------------------------------------------------------------------
-- 4. Which months have been captured.
-- ---------------------------------------------------------------------------

-- The archive alone cannot answer this: a month in which nobody had an
-- approved entry captures zero rows, and without this table the job would
-- retry that month for ever. The primary key is what makes the capture
-- idempotent — running it twice for the same month is refused, which is what
-- lets it be driven by a plain hourly interval that catches up after sleep.
CREATE TABLE IF NOT EXISTS top10_monthly_captures (
  period_year    INTEGER NOT NULL,
  period_month   INTEGER NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  entry_count    INTEGER NOT NULL DEFAULT 0,
  total_votes    INTEGER NOT NULL DEFAULT 0,
  captured_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  captured_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  captured_auto  BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (period_year, period_month)
);
