-- Daily voting for Top 10 — a voter may vote once PER DAY per entry, and
-- the running total never resets. Totals were already SUM(votes.bundle_size)
-- everywhere (never a stored counter), so accumulation across days needs no
-- new arithmetic; what changes is only what the UNIQUE indexes forbid.

-- 1. Which competitions allow daily voting.
--
-- Deliberately per-competition rather than global. `votes` is shared by the
-- Top 10 AND the Arena (BUILT_IN_SLUGS in routes/competitions.js), and the
-- Arena's entrants were told one vote per person. Flipping that rule
-- underneath a competition that is already running would change its result,
-- so daily voting is opt-in and only Top 10 gets it here.
ALTER TABLE competitions ADD COLUMN IF NOT EXISTS daily_voting BOOLEAN NOT NULL DEFAULT false;
UPDATE competitions SET daily_voting = true WHERE slug = 'top-10';

-- 2. Which day a vote belongs to.
--
-- NULL means "this vote is not day-scoped" — one per voter, ever. A date
-- means "one per voter per that date". Every existing row stays NULL, so
-- votes already cast keep behaving exactly as they did and no backfill is
-- needed; nothing about historic totals moves.
--
-- The date is South African, not UTC. Render runs UTC, and SAST is UTC+2 —
-- keying off UTC would roll the day over at 02:00 local, so someone voting
-- at 01:00 would be told they had already used a vote they had not cast yet.
ALTER TABLE votes ADD COLUMN IF NOT EXISTS vote_day DATE;

-- 3. Paid bundle votes get their OWN row instead of being merged into the
--    voter's free-vote row.
--
-- Previously a bundle did ON CONFLICT ... DO UPDATE bundle_size = bundle_size
-- + n, because the old one-row-per-voter index left no alternative. Two
-- consequences of daily voting force this to change:
--   - those ON CONFLICT clauses name the old indexes, and would fail outright
--     once the indexes below replace them;
--   - reversing a bundle did UPDATE ... WHERE entry_id/voter, which with one
--     row per DAY would now match every day's row and subtract the bundle
--     from all of them.
-- A dedicated row makes a reversal exact rather than "best effort" (the term
-- the old reverse route used about itself), because the bundle's votes are no
-- longer pooled with the voter's free ones.
ALTER TABLE votes ADD COLUMN IF NOT EXISTS vote_bundle_id INTEGER REFERENCES vote_bundles(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_votes_bundle ON votes (vote_bundle_id) WHERE vote_bundle_id IS NOT NULL;

-- 4. Replace the two old unique indexes with four.
--
-- Both rules stay enforced by the DATABASE, not by application logic — the
-- original design chose that deliberately and this keeps it. vote_day being
-- NULL vs set is what selects which rule applies, so one schema expresses
-- both "once ever" (Arena) and "once a day" (Top 10) without a magic value.
--
-- All four exclude paid rows (vote_bundle_id IS NOT NULL): those are bought
-- in a quantity the buyer chose, so a uniqueness rule must not apply to them.
DROP INDEX IF EXISTS idx_votes_unique_user;
DROP INDEX IF EXISTS idx_votes_unique_session;

-- Once ever, per signed-in voter.
CREATE UNIQUE INDEX IF NOT EXISTS idx_votes_once_user
  ON votes (entry_id, voter_user_id)
  WHERE voter_user_id IS NOT NULL AND vote_day IS NULL AND vote_bundle_id IS NULL;

-- Once ever, per guest session.
CREATE UNIQUE INDEX IF NOT EXISTS idx_votes_once_session
  ON votes (entry_id, session_id)
  WHERE voter_user_id IS NULL AND vote_day IS NULL AND vote_bundle_id IS NULL;

-- Once per day, per signed-in voter.
CREATE UNIQUE INDEX IF NOT EXISTS idx_votes_daily_user
  ON votes (entry_id, voter_user_id, vote_day)
  WHERE voter_user_id IS NOT NULL AND vote_day IS NOT NULL AND vote_bundle_id IS NULL;

-- Once per day, per guest session.
CREATE UNIQUE INDEX IF NOT EXISTS idx_votes_daily_session
  ON votes (entry_id, session_id, vote_day)
  WHERE voter_user_id IS NULL AND vote_day IS NOT NULL AND vote_bundle_id IS NULL;
