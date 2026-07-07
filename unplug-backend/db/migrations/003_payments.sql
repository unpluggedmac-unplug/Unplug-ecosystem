-- Unplug Ecosystem — Phase 3, Step 3: Payments
-- Depends on 001_users.sql and 002_profiles.sql having already run.

-- Profiles now wait for payment confirmation before entering the Admin
-- Approval Queue. Previously the only statuses were pending/approved/rejected;
-- 'awaiting_payment' is inserted ahead of 'pending' in that lifecycle.
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_status_check;
ALTER TABLE profiles ADD CONSTRAINT profiles_status_check
  CHECK (status IN ('awaiting_payment', 'pending', 'approved', 'rejected'));

CREATE TABLE IF NOT EXISTS payments (
  id                SERIAL PRIMARY KEY,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount            NUMERIC(10,2) NOT NULL,
  method            VARCHAR(10) NOT NULL CHECK (method IN ('payfast', 'ozow', 'eft')),
  gateway_reference VARCHAR(120) NOT NULL UNIQUE,
  status            VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'confirmed', 'failed')),
  linked_type       VARCHAR(30) NOT NULL
                    CHECK (linked_type IN ('profile_package', 'profile_upgrade', 'competition_entry', 'highlight', 'marketplace_listing')),
  linked_id         INTEGER NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_payments_user ON payments (user_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments (status);
CREATE INDEX IF NOT EXISTS idx_payments_linked ON payments (linked_type, linked_id);
