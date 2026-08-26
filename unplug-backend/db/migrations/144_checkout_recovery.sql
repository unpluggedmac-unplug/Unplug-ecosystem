-- Checkout recovery: saved carts, and reminders for orders that stalled.
--
-- TWO DIFFERENT THINGS ARE BEING RECOVERED HERE, and conflating them produces
-- the email everybody hates.
--
--   A SAVED CART is somebody who chose services and never checked out. There
--   was no server-side record of this at all before — the cart lives in the
--   browser's localStorage and is only sent at POST /orders/initiate — so this
--   table is NEW DATA ABOUT PEOPLE that the site did not previously keep. It
--   is what somebody intended to buy and then did not. That is a real change
--   in what is stored about a signed-in member, and the privacy policy says so.
--
--   A PENDING ORDER is somebody who did check out. And "pending" means two
--   opposite things depending on how they chose to pay:
--
--     payfast / ozow — they bounced off the payment gateway. Genuinely
--                      abandoned, and "you didn't finish" is accurate.
--     eft            — pending is the CORRECT AND EXPECTED state. They have
--                      been given a reference and are going to their bank.
--                      Telling this person they failed to finish is both
--                      wrong and rude; what helps them is the reference again.
--
--   The two get different messages. Same machinery, different words, because
--   the situations are not the same.
--
-- ONLY SIGNED-IN MEMBERS. Checkout requires an account (requireAuth on
-- /orders/initiate), so there is no anonymous cart to save and no address to
-- guess at. Nothing here applies to a logged-out visitor.
--
-- Reversal: drop saved_carts and the three columns added to orders. Nothing
-- else references them; the reminder runner does nothing when the table is
-- absent because it only ever reads.

-- ---------------------------------------------------------------------------
-- Saved carts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS saved_carts (
  -- ONE CART PER PERSON, enforced as the primary key rather than by the
  -- application. A second row would mean two answers to "what is in my cart",
  -- and whichever the query happened to return first would win.
  user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,

  -- The same { linkedType, linkedId } shape POST /orders/initiate already
  -- validates. Stored as given and RE-PRICED at checkout, never trusted for
  -- money: a cart saved in March must not be able to buy at March's price in
  -- September, and a stored price is exactly the thing somebody would edit.
  items        JSONB NOT NULL DEFAULT '[]',

  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- How many reminders have gone out for THIS cart, and when the last one was.
  -- Reset whenever the cart changes, because a cart somebody has just edited
  -- is a live intention again rather than the one they already ignored twice.
  reminders_sent  INTEGER NOT NULL DEFAULT 0,
  last_reminded_at TIMESTAMPTZ,

  -- Set when they check out. The row is KEPT rather than deleted so that
  -- "have we already chased this person" survives, and so a cart that becomes
  -- an order cannot be chased as though it were still abandoned.
  converted_at TIMESTAMPTZ
);

-- The reminder runner's only query: carts with something in them, not yet
-- converted, not yet chased twice. Partial so it stays small as converted
-- carts accumulate.
CREATE INDEX IF NOT EXISTS idx_saved_carts_due
  ON saved_carts (updated_at)
  WHERE converted_at IS NULL AND reminders_sent < 2;

-- ---------------------------------------------------------------------------
-- Order reminders
-- ---------------------------------------------------------------------------
--
-- Columns on orders rather than a table of their own: there is exactly one
-- reminder state per order and it has no history worth keeping separately.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS reminders_sent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS last_reminded_at TIMESTAMPTZ;

-- Somebody can ask not to be chased about a specific order without
-- unsubscribing from everything. Without this the only way to stop one
-- reminder is to leave the mailing list entirely, which is a much bigger
-- thing than they meant.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS recovery_opted_out BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_orders_recovery
  ON orders (status, created_at)
  WHERE status = 'pending' AND recovery_opted_out = false;
