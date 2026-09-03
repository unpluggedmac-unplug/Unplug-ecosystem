-- The §9.2 voting rule: a maximum of 5 online votes per person per calendar
-- day, ACROSS THE WHOLE COMPETITION, spread over at least two contestants.
--
-- THIS MIGRATION DOES NOT TURN IT ON. The column ships NULL everywhere, NULL
-- means "no cap", and NULL is exactly today's behaviour. Nothing about any
-- running competition changes when this deploys.
--
-- WHY PER-COMPETITION rather than one global switch: this is the same choice
-- 098_daily_voting.sql made, for the same reason, in its own words — flipping a
-- rule underneath a competition that is already running would change its
-- result. `votes` is shared by the Top 10 and the Arena, and their voters were
-- told different rules. A per-competition column lets each one cut over at a
-- moment somebody chooses, between rounds or with an announcement, rather than
-- everything moving at once because a deploy happened.
--
-- WHAT IS ALREADY ENFORCED, and therefore not rebuilt here:
--
--   §9.2 also says the five votes "must be spread across at least two
--   contestants" and that five for one contestant is not allowed. That is
--   already true wherever daily_voting is on: 098 created a unique index of
--   (entry_id, voter, vote_day), so a voter cannot cast a second free vote for
--   the SAME entry on the same day at all. The distribution rule needs no new
--   machinery — it needs the cap, which is what this adds.

-- NULL = no cap = today. A number is the most free votes one voter may cast in
-- this competition in one South African day.
ALTER TABLE competitions ADD COLUMN IF NOT EXISTS daily_vote_limit INTEGER;

-- A cap of zero would mean "voting is closed", which is what competitions.status
-- is for; a negative one is meaningless. Guarding it here keeps a typo in an
-- admin form from silently disabling a competition's voting.
ALTER TABLE competitions DROP CONSTRAINT IF EXISTS competitions_daily_vote_limit_check;
ALTER TABLE competitions ADD CONSTRAINT competitions_daily_vote_limit_check
  CHECK (daily_vote_limit IS NULL OR daily_vote_limit >= 1);

-- Counting a voter's votes for one competition on one day is the hot path of
-- the rule, so it is indexed. Free votes only — paid bundle rows are not
-- capped, and excluding them keeps the index small.
CREATE INDEX IF NOT EXISTS idx_votes_daily_count
  ON votes (voter_user_id, vote_day)
  WHERE vote_day IS NOT NULL AND vote_bundle_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_votes_daily_count_session
  ON votes (session_id, vote_day)
  WHERE vote_day IS NOT NULL AND vote_bundle_id IS NULL;

COMMENT ON COLUMN competitions.daily_vote_limit IS
  'Spec 9.2: max free votes per voter per SA day for this competition. NULL = no cap (pre-9.2 behaviour). Set deliberately at cutover, not by deploy.';
