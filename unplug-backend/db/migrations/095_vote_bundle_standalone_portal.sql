-- Payment Portal Redevelopment — Phase 2: Top 10 Bulk Votes as a fully
-- separate, anonymous portal.
--
-- Investigated first: the backend already supported anonymous bundle
-- creation (vote_bundles.session_id, no requireAuth on POST
-- /entries/:id/vote-bundle) and anonymous entry lookup (GET
-- /entries/by-code/:code, GET /entries/:id, no auth). But the only way to
-- actually PAY for one was POST /payments/initiate, which has requireAuth
-- unconditionally, backed by payments.user_id INTEGER NOT NULL — so a
-- signed-out visitor could create a bundle but could never pay for it.
-- The frontend (unplug-checkout.html) never exposed this gap because it
-- puts a mandatory login form in front of EVERY checkout mode, vote
-- bundles included, despite the backend being built to allow guests.
--
-- Rather than loosen payments.user_id (a shared, heavily-used table behind
-- 11 OTHER flows — NOT the right place to add an anonymous path, and the
-- brief is explicit that the two portals "must never interfere with each
-- other"), vote_bundles gets its own small, self-contained EFT flow —
-- the exact same pattern edition_purchases already uses for exactly the
-- same reason (see 003_payments.sql / editions.js). No changes to the
-- payments table or /payments/initiate at all.
ALTER TABLE vote_bundles ADD COLUMN IF NOT EXISTS reference VARCHAR(10) UNIQUE;
ALTER TABLE vote_bundles ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ;
ALTER TABLE vote_bundles ADD COLUMN IF NOT EXISTS terms_version VARCHAR(20);
ALTER TABLE vote_bundles ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;
ALTER TABLE vote_bundles ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ;

ALTER TABLE vote_bundles DROP CONSTRAINT IF EXISTS vote_bundles_status_check;
ALTER TABLE vote_bundles ADD CONSTRAINT vote_bundles_status_check
  CHECK (status IN ('awaiting_payment', 'confirmed', 'rejected', 'reversed'));

-- get_content_stats-style enrichment for the entry-lookup queries (by-code,
-- by-id, and the new search-by-name) — the brief's Portal 2 Step 1 wants
-- Photo, Name, Category and Current Votes shown together, not just name.
-- No schema change needed here — vote_count is computed the same way
-- GET /competitions/:slug already computes it (SUM over votes.bundle_size);
-- this note just records that competitions.js's ENTRY_LOOKUP_SELECT and
-- the new /entries/search route both add that same aggregation.
