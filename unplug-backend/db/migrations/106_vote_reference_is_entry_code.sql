-- The Reference Code a bulk-vote buyer puts on their EFT is now the
-- contestant's entry code, exactly — no suffix.
--
-- Migration 104 made it entry code PLUS a unique suffix, for a good reason
-- that has not gone away: an entry code identifies the CONTESTANT, not the
-- PURCHASE, so five people buying votes for the same person now all send the
-- identical reference and the admin queue cannot tell one R250 from another
-- by reference alone. That tradeoff was accepted deliberately — one code,
-- called the Reference Code, everywhere a customer sees it — and the admin
-- queue compensates by showing amount, date and buyer beside the reference.
--
-- Two things follow, and both are handled here rather than left implicit.
--
-- 1. reference can no longer be UNIQUE. Dropping that constraint is what
--    lets the second buyer for a contestant check out at all; without this
--    their payment would fail on a duplicate key.
--
-- 2. reference can no longer be the buyer's CREDENTIAL. This portal has no
--    login, and until now the reference was unguessable, so "knows the
--    reference" was a fair stand-in for "is the buyer" on the status page
--    and the proof-of-payment upload. An entry code is printed publicly next
--    to every contestant on the Top 10 page — so if nothing else changed,
--    anyone could read a code off the site and attach files to a stranger's
--    purchase. lookup_token replaces it: unguessable, never presented as
--    "your reference", handed back once at checkout and kept in the buyer's
--    own link.
--
-- Existing rows keep the references already issued and already quoted on
-- real EFTs. Nothing is rewritten.

ALTER TABLE vote_bundles ADD COLUMN IF NOT EXISTS lookup_token VARCHAR(32);

-- Backfill from the existing reference, which was unique by construction, so
-- every link and bookmark already in the wild keeps working.
UPDATE vote_bundles SET lookup_token = reference WHERE lookup_token IS NULL AND reference IS NOT NULL;

-- Rows old enough to predate references at all get a generated token rather
-- than being left unreachable.
UPDATE vote_bundles
   SET lookup_token = 'VB' || lpad(id::text, 8, '0') || substr(md5(random()::text), 1, 10)
 WHERE lookup_token IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_vote_bundles_lookup_token
  ON vote_bundles (lookup_token) WHERE lookup_token IS NOT NULL;

-- The constraint Postgres created for the inline UNIQUE in migration 095.
ALTER TABLE vote_bundles DROP CONSTRAINT IF EXISTS vote_bundles_reference_key;

-- Still indexed — the admin queue and the buyer's fallback lookup both search
-- by it — just no longer unique.
CREATE INDEX IF NOT EXISTS idx_vote_bundles_reference ON vote_bundles (reference);
