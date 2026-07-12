-- Admin-issued vouchers: each code can be used once per user, must have a
-- mandatory expiry date, and can optionally be restricted to one service
-- (e.g. only Directory packages). Separate from the profile free-credit
-- system already built (free_article_credits etc.) — vouchers are
-- admin-controlled, one-off codes; profile credits are automatic tier perks.

CREATE TABLE IF NOT EXISTS vouchers (
  id                SERIAL PRIMARY KEY,
  code              VARCHAR(40) NOT NULL UNIQUE,
  discount_type     VARCHAR(10) NOT NULL CHECK (discount_type IN ('percent', 'fixed')),
  discount_value    NUMERIC(10,2) NOT NULL,
  service_restriction VARCHAR(40),  -- NULL = valid for any paid service
  expires_at        TIMESTAMPTZ NOT NULL,
  active            BOOLEAN NOT NULL DEFAULT true,
  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One redemption per user per voucher code — this is what "multi-use"
-- means here: many different users can each redeem the same code once,
-- but nobody can redeem the same code twice.
CREATE TABLE IF NOT EXISTS voucher_redemptions (
  id              SERIAL PRIMARY KEY,
  voucher_id      INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  linked_type     VARCHAR(40) NOT NULL,
  linked_id       INTEGER NOT NULL,
  discount_amount NUMERIC(10,2) NOT NULL,
  redeemed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (voucher_id, user_id)
);
