-- Invoices (spec §10.5).
--
-- An invoice needs a NUMBER, and a number is only worth anything if it is
-- stable: the same order must show the same invoice number today, tomorrow and
-- in an audit. That cannot come from a join or a derivation, so it is stored.
--
-- WHY THE MONEY IS COPIED HERE rather than read from the order every time:
-- an invoice is a record of what was charged AT THE MOMENT IT WAS ISSUED. That
-- is the whole point of issuing one. If the order is ever corrected, the
-- invoice that was already given to a member must not silently change under
-- them. The duplication is deliberate and is the accounting behaviour.
--
-- Only CONFIRMED orders get one. An invoice for money that never arrived is a
-- document that should not exist.

CREATE SEQUENCE IF NOT EXISTS invoice_number_seq;

CREATE TABLE IF NOT EXISTS invoices (
  id                SERIAL PRIMARY KEY,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- SET NULL, not CASCADE: if an order row is ever removed, the financial
  -- record of what was charged should outlive it. UNIQUE keeps it one invoice
  -- per order (Postgres allows many NULLs in a unique column, so orphaned
  -- invoices do not collide).
  order_id          INTEGER UNIQUE REFERENCES orders(id) ON DELETE SET NULL,
  invoice_number    VARCHAR(24) NOT NULL UNIQUE,
  -- The Unplug reference the member already knows. §10.5 lists the invoice
  -- number and the reference as SEPARATE fields, because they are: one
  -- identifies the document, the other identifies the purchase.
  reference         VARCHAR(20) NOT NULL,
  issued_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  subtotal          NUMERIC(10,2) NOT NULL,
  voucher_discount  NUMERIC(10,2) NOT NULL DEFAULT 0,
  credit_used       NUMERIC(10,2) NOT NULL DEFAULT 0,
  total             NUMERIC(10,2) NOT NULL,
  method            VARCHAR(10) NOT NULL,
  status            VARCHAR(20) NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invoices_user ON invoices (user_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_reference ON invoices (reference);

-- ONE PLACE THAT FORMATS AN INVOICE NUMBER.
--
-- The backfill below and the application both call this, so a number issued by
-- a migration and a number issued by a checkout cannot end up in different
-- shapes. The year comes from the date the invoice is issued FOR, not from
-- now(), so backfilled invoices carry the year they were actually paid in.
--
-- The counter never resets. A number is never reused, which is the property
-- that makes it worth printing on a document.
CREATE OR REPLACE FUNCTION next_invoice_number(issued timestamptz)
RETURNS VARCHAR(24) AS $$
  SELECT 'INV-' || to_char($1, 'YYYY') || '-'
         || lpad(nextval('invoice_number_seq')::text, 6, '0');
$$ LANGUAGE sql VOLATILE;

-- Backfill every confirmed order that has no invoice yet, oldest first, so a
-- member who paid last month can still find theirs.
--
-- IDEMPOTENT: the NOT EXISTS means a re-run on the next deploy matches no rows
-- and therefore consumes no sequence values. Migrations here run on EVERY
-- deploy, so this has to be true rather than merely likely.
INSERT INTO invoices (user_id, order_id, invoice_number, reference, issued_at,
                      subtotal, voucher_discount, credit_used, total, method, status)
SELECT o.user_id,
       o.id,
       next_invoice_number(COALESCE(o.confirmed_at, o.created_at)),
       o.reference,
       COALESCE(o.confirmed_at, o.created_at),
       o.subtotal,
       o.voucher_discount,
       o.credit_used,
       o.total,
       o.method,
       o.status
  FROM orders o
 WHERE o.status = 'confirmed'
   AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.order_id = o.id)
 ORDER BY COALESCE(o.confirmed_at, o.created_at) ASC, o.id ASC;

-- VAT, as configuration rather than as code.
--
-- Unplug's prices are VAT-INCLUSIVE, so the invoice has to show the VAT portion
-- of the total. A South African tax invoice must also carry the vendor's VAT
-- registration number, and that number is a fact about the business, not
-- something source control should invent: it is seeded EMPTY and an admin sets
-- it via PATCH /admin/settings/vat_registration_number.
--
-- Until it is set, the document renders as a plain INVOICE with no VAT line.
-- That is the safe direction to fail: a tax invoice missing its registration
-- number is worse than an invoice that does not claim to be one.
INSERT INTO settings (key, value) VALUES ('vat_registration_number', '')
ON CONFLICT (key) DO NOTHING;

INSERT INTO settings (key, value) VALUES ('vat_rate', '15.00')
ON CONFLICT (key) DO NOTHING;

COMMENT ON TABLE invoices IS
  'One per confirmed order. Money is copied, not joined: an invoice records what was charged when it was issued.';
COMMENT ON COLUMN invoices.invoice_number IS
  'INV-YYYY-NNNNNN. Allocated by next_invoice_number(); never reused.';
