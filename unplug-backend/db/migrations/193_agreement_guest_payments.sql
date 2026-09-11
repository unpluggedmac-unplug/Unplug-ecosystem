-- Agreement Forms — admin-selectable guest payment support (option C).
--
-- The site owner chose a per-agreement switch:
--   * guest_payment_allowed = false (default): a paid agreement requires an
--     authenticated Unplug account;
--   * guest_payment_allowed = true: an external signer can pay by EFT without
--     being forced to create an account.
--
-- This extends the EXISTING payments table instead of creating a second money
-- ledger. Guest identity lives on the payment only when user_id is NULL.

ALTER TABLE agreement_forms
  ADD COLUMN IF NOT EXISTS guest_payment_allowed BOOLEAN NOT NULL DEFAULT false;

-- Existing payments always have a user_id; dropping NOT NULL therefore changes
-- no historic row. It only permits the narrowly-scoped agreement guest checkout
-- route to create future guest payments.
ALTER TABLE payments ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS guest_payer_name VARCHAR(200);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS guest_payer_email VARCHAR(255);

-- A payment must still identify a payer one way or the other. This is NOT
-- installed as a table-wide CHECK because old environments may contain test
-- rows that pre-date identity capture. The Agreement route enforces it for all
-- new agreement payments and the partial index below supports lookup/admin use.
CREATE INDEX IF NOT EXISTS idx_payments_guest_email
  ON payments (LOWER(guest_payer_email)) WHERE guest_payer_email IS NOT NULL;

-- Keep Agreement submission payment state synchronized no matter HOW a payment
-- is confirmed: manual EFT confirmation, a future gateway webhook, or an admin
-- retry. That avoids duplicating Agreement-specific fulfillment logic in every
-- payment confirmation path.
CREATE OR REPLACE FUNCTION sync_agreement_payment_state()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.linked_type <> 'agreement_payment' THEN
    RETURN NEW;
  END IF;

  UPDATE agreement_submissions
     SET payment_id = NEW.id,
         payment_status = CASE
           WHEN NEW.status = 'confirmed' THEN 'confirmed'
           WHEN NEW.status = 'failed' THEN 'failed'
           ELSE 'awaiting_payment'
         END,
         status = CASE
           WHEN NEW.status = 'confirmed' AND payment_mode_at_signing = 'before_sign'
             THEN 'ready_to_sign'
           WHEN NEW.status = 'confirmed' AND payment_mode_at_signing = 'after_sign'
             THEN 'complete'
           WHEN NEW.status = 'failed' AND signed_at IS NOT NULL
             THEN 'awaiting_payment'
           WHEN NEW.status = 'failed'
             THEN 'started'
           ELSE status
         END
   WHERE id = NEW.linked_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_agreement_payment_state ON payments;
CREATE TRIGGER trg_sync_agreement_payment_state
AFTER INSERT OR UPDATE OF status ON payments
FOR EACH ROW EXECUTE FUNCTION sync_agreement_payment_state();
