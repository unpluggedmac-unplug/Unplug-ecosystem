-- Unplug Ecosystem — Phase 3, Step 5: Competitions, Top 10, Voting
-- Depends on 001_users.sql, 002_profiles.sql, 003_payments.sql having already run.

CREATE TABLE IF NOT EXISTS competitions (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(160) NOT NULL,
  slug          VARCHAR(180) NOT NULL UNIQUE,
  description   TEXT,
  opens_at      TIMESTAMPTZ NOT NULL,
  closes_at     TIMESTAMPTZ NOT NULL,
  status        VARCHAR(20) NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'open', 'closed')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_competitions_status ON competitions (status);

CREATE TABLE IF NOT EXISTS competition_entries (
  id                SERIAL PRIMARY KEY,
  competition_id    INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  profile_id        INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  entry_fee         NUMERIC(10,2) NOT NULL DEFAULT 50.00,
  status            VARCHAR(20) NOT NULL DEFAULT 'awaiting_payment'
                    CHECK (status IN ('awaiting_payment', 'pending', 'approved', 'rejected')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (competition_id, profile_id)
);
CREATE INDEX IF NOT EXISTS idx_entries_status ON competition_entries (status);
CREATE INDEX IF NOT EXISTS idx_entries_competition ON competition_entries (competition_id);

-- One vote per user (if logged in) or per browser session (if guest),
-- per entry — the UNIQUE constraints below enforce that at the database
-- level rather than trusting application logic alone.
CREATE TABLE IF NOT EXISTS votes (
  id            SERIAL PRIMARY KEY,
  entry_id      INTEGER NOT NULL REFERENCES competition_entries(id) ON DELETE CASCADE,
  voter_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  session_id    VARCHAR(120),
  bundle_size   INTEGER NOT NULL DEFAULT 1,
  payment_id    INTEGER REFERENCES payments(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (voter_user_id IS NOT NULL OR session_id IS NOT NULL)
);
-- The two UNIQUE indexes that used to be created here (idx_votes_unique_user
-- and idx_votes_unique_session, one vote per voter per entry for ever) now
-- live in 098_daily_voting.sql, which replaced them with four that also
-- express "one vote per day" for competitions that allow it.
--
-- They cannot be recreated here. Every migration re-runs on every deploy, so
-- this file would rebuild the old index moments before 098 drops it again —
-- and the moment a voter has legitimately voted on two different days, that
-- rebuild fails on duplicate keys and takes the whole deploy's migration run
-- down with it. Caught by the idempotency test in test/dailyVoting.test.js.
CREATE INDEX IF NOT EXISTS idx_votes_entry ON votes (entry_id);

-- Current period only — no historical archive, per the locked Blueprint
-- (Section 6). Each ranking cycle truncates and rewrites this table rather
-- than accumulating rows.
CREATE TABLE IF NOT EXISTS top10_rankings (
  id            SERIAL PRIMARY KEY,
  period_label  VARCHAR(60) NOT NULL,
  profile_id    INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  rank          SMALLINT NOT NULL CHECK (rank BETWEEN 1 AND 10),
  cause_text    VARCHAR(255),
  UNIQUE (rank)
);

-- Allow competition_entries as a valid payments.linked_type — this was
-- already anticipated in 003_payments.sql's CHECK constraint, so no
-- ALTER is needed here. Confirmed by inspection of that migration.

-- Bundle/paid voting ("Bundle Vote" on the homepage) is NOT wired yet —
-- the price per extra vote was never confirmed during planning. When it
-- is, add 'vote_bundle' to the linked_type CHECK in 003_payments.sql (or
-- a new migration altering it) and extend resolveAmount() in payments.js.
