-- Unplug Ecosystem — Phase 3, Step 10: Platform Settings & Bundle Voting
-- Depends on 001_users.sql through 007_sales_consultants.sql having already run.

-- A small generic key/value settings table for admin-configurable values
-- that don't deserve their own dedicated table — starting with the Bundle
-- Vote price, which was left unset during planning.
CREATE TABLE IF NOT EXISTS settings (
  key           VARCHAR(60) PRIMARY KEY,
  value         VARCHAR(255) NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed a sensible default so voting doesn't break before an admin sets a
-- real number — R10 per extra vote is a placeholder, not a business
-- decision; change it via PATCH /admin/settings/bundle_vote_price.
INSERT INTO settings (key, value) VALUES ('bundle_vote_price', '10.00')
ON CONFLICT (key) DO NOTHING;

-- Now that bundle voting has a price, it's a real payments.linked_type.
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_linked_type_check;
ALTER TABLE payments ADD CONSTRAINT payments_linked_type_check
  CHECK (linked_type IN ('profile_package', 'profile_upgrade', 'competition_entry', 'highlight', 'marketplace_listing', 'vote_bundle'));

-- A pending bundle vote purchase — how many extra votes, for which entry,
-- awaiting payment. On confirmation, this becomes real rows in `votes`
-- (see applyPaymentEffect in payments.js).
CREATE TABLE IF NOT EXISTS vote_bundles (
  id            SERIAL PRIMARY KEY,
  entry_id      INTEGER NOT NULL REFERENCES competition_entries(id) ON DELETE CASCADE,
  buyer_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  session_id    VARCHAR(120),
  vote_count    INTEGER NOT NULL CHECK (vote_count > 0),
  price         NUMERIC(10,2) NOT NULL,
  status        VARCHAR(20) NOT NULL DEFAULT 'awaiting_payment'
                CHECK (status IN ('awaiting_payment', 'confirmed')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (buyer_user_id IS NOT NULL OR session_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_vote_bundles_entry ON vote_bundles (entry_id);
