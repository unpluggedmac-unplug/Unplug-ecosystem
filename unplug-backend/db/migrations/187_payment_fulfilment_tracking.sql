-- Phase 10 — payment fulfilment tracking.
-- A payment being confirmed and its service being activated are two distinct
-- facts. Track the second one explicitly so a paid-but-unfulfilled service can
-- be found and retried instead of disappearing behind a confirmed payment row.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS fulfillment_status VARCHAR(24) NOT NULL DEFAULT 'pending';
ALTER TABLE payments ADD COLUMN IF NOT EXISTS fulfillment_error TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS fulfilled_at TIMESTAMPTZ;

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_fulfillment_status_check;
ALTER TABLE payments ADD CONSTRAINT payments_fulfillment_status_check
  CHECK (fulfillment_status IN ('pending','applied','failed','assumed_applied'));

-- Historical confirmed rows pre-date this tracking. We must not pretend we
-- re-ran them during migration, so label them honestly as assumed_applied.
UPDATE payments
   SET fulfillment_status = 'assumed_applied', fulfilled_at = COALESCE(fulfilled_at, confirmed_at)
 WHERE status = 'confirmed' AND fulfillment_status = 'pending';

CREATE INDEX IF NOT EXISTS idx_payments_fulfillment_status ON payments(fulfillment_status);
