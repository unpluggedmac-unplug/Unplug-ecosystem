-- Mandatory Terms acceptance + credit accounting recorded against each order.
-- Extends the existing payments table (no separate checkout system).
ALTER TABLE payments ADD COLUMN IF NOT EXISTS terms_version     VARCHAR(20);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS terms_accepted_at  TIMESTAMPTZ;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS terms_ip           VARCHAR(60);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS terms_user_agent   TEXT;
-- Credit accounting: order_total is the full price; amount stays the payable
-- balance (what still had to be paid after credit) so gateways are unaffected.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS credit_used        NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS order_total        NUMERIC(10,2);
