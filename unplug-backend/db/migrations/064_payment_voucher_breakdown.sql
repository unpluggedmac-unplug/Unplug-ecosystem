-- Record the voucher component of a payment on the payment itself.
--
-- The voucher was already validated and applied at checkout (and logged in
-- voucher_redemptions), but the payments row only stored order_total,
-- credit_used and amount — so an admin looking at one order could see the
-- credit and the cash but not how much of the discount came from a voucher.
-- These two columns complete the breakdown:
--   order_total - voucher_discount - credit_used = amount (the EFT/cash part)
--
-- Nullable with no default: a metadata-only change that cannot fail on
-- existing rows, and historic payments simply show no voucher.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS voucher_discount NUMERIC(10,2);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS voucher_code     VARCHAR(40);
