-- Freeze the guest-payment rule with each Agreement signing/payment session.
-- Changing the admin switch tomorrow must not strand somebody who already
-- started or signed under today's payment policy.

ALTER TABLE agreement_submissions
  ADD COLUMN IF NOT EXISTS guest_payment_allowed_at_signing BOOLEAN;

CREATE OR REPLACE FUNCTION snapshot_agreement_payment_policy()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.guest_payment_allowed_at_signing IS NULL THEN
    SELECT guest_payment_allowed
      INTO NEW.guest_payment_allowed_at_signing
      FROM agreement_forms
     WHERE id = NEW.agreement_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_snapshot_agreement_payment_policy ON agreement_submissions;
CREATE TRIGGER trg_snapshot_agreement_payment_policy
BEFORE INSERT ON agreement_submissions
FOR EACH ROW EXECUTE FUNCTION snapshot_agreement_payment_policy();

-- Safe backfill for rows created earlier on this feature branch during tests.
UPDATE agreement_submissions s
   SET guest_payment_allowed_at_signing = a.guest_payment_allowed
  FROM agreement_forms a
 WHERE a.id = s.agreement_id
   AND s.guest_payment_allowed_at_signing IS NULL;
