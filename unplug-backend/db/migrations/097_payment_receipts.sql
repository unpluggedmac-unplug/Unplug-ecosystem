-- Payment Portal Redevelopment — Phase 6: proof-of-payment upload, plus
-- admin-generated invoice/receipt documents. Added to every surface that
-- can be paid by EFT: standalone payments, cart orders, and standalone
-- vote bundles.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS pop_url TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS invoice_url TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS receipt_url TEXT;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS pop_url TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_url TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS receipt_url TEXT;

ALTER TABLE vote_bundles ADD COLUMN IF NOT EXISTS pop_url TEXT;
ALTER TABLE vote_bundles ADD COLUMN IF NOT EXISTS invoice_url TEXT;
ALTER TABLE vote_bundles ADD COLUMN IF NOT EXISTS receipt_url TEXT;
