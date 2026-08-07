-- Payment Portal Redevelopment — Phase 3: multi-service cart checkout.
--
-- Design: an `orders` row holds everything that is genuinely order-level
-- (one reference, one voucher, one credit deduction, one Terms acceptance,
-- one EFT payment covering the whole cart). Each service in the cart is
-- still a real, individual row in the EXISTING `payments` table (now
-- optionally linked to an order via order_id) — NOT a new parallel
-- "order_items" table duplicating linked_type/linked_id/amount/status.
--
-- Why: every one of the 10 cart-eligible services' "what happens once
-- this is paid" logic (applyPaymentEffect in payments.js) already works
-- per-payments-row, and some of it has real foreign keys INTO payments.id
-- (ad_slots.payment_id, edition_purchases.payment_id) — a fake or
-- order-shaped id would break those constraints. Reusing real payments
-- rows means applyPaymentEffect, resolveAmount, and applyVoucher all work
-- completely unchanged; only what CALLS them (once per cart item instead
-- of once per checkout) is new. See routes/orders.js.
--
-- Deliberately excludes edition_download and vote_bundle from being
-- cart-eligible — neither appears in the brief's Portal 1 service list,
-- and both already have their own standalone purchase flows (Editions'
-- own EFT system, and vote_bundles' own standalone portal from Phase 2).
-- The tables below don't prevent those linked_types from working through
-- this system if a caller asked for them; the new frontend cart simply
-- never offers them as selectable services.

CREATE TABLE IF NOT EXISTS orders (
  id                 SERIAL PRIMARY KEY,
  user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reference          VARCHAR(20) NOT NULL UNIQUE,
  method             VARCHAR(10) NOT NULL CHECK (method IN ('payfast', 'ozow', 'eft')),
  status             VARCHAR(20) NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'confirmed', 'failed')),
  subtotal           NUMERIC(10,2) NOT NULL,
  voucher_code       VARCHAR(40),
  voucher_discount   NUMERIC(10,2) NOT NULL DEFAULT 0,
  credit_used        NUMERIC(10,2) NOT NULL DEFAULT 0,
  total              NUMERIC(10,2) NOT NULL,
  referral_source    VARCHAR(30),
  sales_consultant_id INTEGER REFERENCES sales_consultants(id),
  terms_version      VARCHAR(20) NOT NULL,
  terms_accepted_at  TIMESTAMPTZ NOT NULL,
  terms_ip           VARCHAR(64),
  terms_user_agent   TEXT,
  info_confirmed_at  TIMESTAMPTZ NOT NULL, -- Step 9's SEPARATE "I confirm all information is correct" checkbox
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders (user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status);

ALTER TABLE payments ADD COLUMN IF NOT EXISTS order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments (order_id) WHERE order_id IS NOT NULL;

-- A payments row created through the cart is no longer optional-linkedId —
-- every one belongs to a real service. gateway_reference stays UNIQUE per
-- row (it always was), so each item gets `${orderReference}-${n}`; the
-- order's own `reference` is what the admin actually confirms once and
-- what the customer quotes on their EFT.
