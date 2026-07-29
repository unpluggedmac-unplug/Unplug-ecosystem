-- Mandatory Terms acceptance + credit accounting recorded against each order.
-- Extends the existing payments table (no separate checkout system).
--
-- IMPORTANT: every column is added NULLABLE with NO default. Adding a column
-- with NOT NULL/DEFAULT can force Postgres to rewrite & re-validate the whole
-- table (ATRewriteTable), which fails if any existing row trips an old CHECK
-- constraint. Plain nullable ADD COLUMN is always a fast metadata-only change,
-- so this migration can never fail on existing data. credit_used is backfilled
-- to 0 afterwards; the app always writes it explicitly on every new order.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS terms_version     VARCHAR(20);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS terms_accepted_at  TIMESTAMPTZ;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS terms_ip           VARCHAR(60);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS terms_user_agent   TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS credit_used        NUMERIC(10,2);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS order_total        NUMERIC(10,2);

UPDATE payments SET credit_used = 0 WHERE credit_used IS NULL;
