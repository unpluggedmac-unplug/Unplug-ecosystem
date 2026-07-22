-- Account credit in rands.
--
-- The Refund & Cancellation Policy promises that a declined or cancelled paid
-- submission becomes credit on the member's account instead of a cash refund.
-- Nothing in the schema could hold that: the existing free_*_credits columns
-- are COUNTS of free services granted by a package tier, not money, and using
-- them here would conflate a perk with a debt we owe someone.
--
-- This is a ledger, not a balance column. Money that appears on an account
-- without a row saying where it came from is impossible to audit, argue about,
-- or correct. The balance is the SUM of the ledger, so it cannot drift out of
-- step with its own history the way an incremented column can.
CREATE TABLE IF NOT EXISTS account_credits (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Positive grants credit, negative spends it. One table for both directions
  -- so the balance is a single SUM and the history reads in order.
  amount      NUMERIC(10,2) NOT NULL CHECK (amount <> 0),
  reason      VARCHAR(40) NOT NULL
              CHECK (reason IN ('declined_submission', 'cancelled_service',
                                'admin_adjustment', 'spent_at_checkout')),
  note        TEXT,
  -- The payment this credit came from, when it came from one. UNIQUE below is
  -- what actually stops a double-credit.
  payment_id  INTEGER REFERENCES payments(id) ON DELETE SET NULL,
  -- Which admin did it. A credit is money; it should never be anonymous.
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS account_credits_user_idx ON account_credits (user_id, created_at DESC);

-- The real guard against crediting the same payment twice. A double-click, a
-- retried request or two admins working the queue at once would otherwise each
-- insert a row and hand out the money again. A partial unique index lets many
-- rows have no payment (admin adjustments, checkout spends) while allowing any
-- one payment to be credited exactly once.
CREATE UNIQUE INDEX IF NOT EXISTS account_credits_payment_once
  ON account_credits (payment_id) WHERE payment_id IS NOT NULL;

-- Mirrors the ledger on the payment itself so the payments table alone shows
-- that this money was returned as credit rather than kept.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS credited_at TIMESTAMPTZ;
