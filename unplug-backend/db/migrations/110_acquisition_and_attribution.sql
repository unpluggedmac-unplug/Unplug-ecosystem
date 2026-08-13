-- Acquisition source at signup, admin consultant assignment, and what those
-- two mean for commission.
--
-- Ported from the My Unplug reference package, which modelled these as a
-- separate `Representative` roster. Deliberately NOT copied that way: the 18
-- "representatives" it seeds are, name for name, the sales_consultants
-- already in this database and already driving commission. A second roster
-- would mean the same person holding two ids, and referral answers landing
-- somewhere the commission calculation never looks.
--
-- COMMISSION RULE (the owner's, stated on 2026-08-13): the consultant a
-- member picks at signup is the one who earns commission on that member's
-- payments, unless an admin reassigns them. Resolution order, highest first:
--
--   1. assigned_consultant_id   — an admin said so; overrides everything
--   2. acquisition_consultant_id — what the member said at signup
--   3. whatever was picked at that individual checkout — today's behaviour,
--      kept so anonymous buyers and existing flows are unaffected
--
-- Applies to payments created from here on. Nothing already recorded is
-- re-attributed: that money has been reported and possibly paid out, and
-- silently moving it between consultants would be indefensible.

-- --- Acquisition: what the member said when they signed up ------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS acquisition_source VARCHAR(30);
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_acquisition_source_check;
ALTER TABLE users ADD CONSTRAINT users_acquisition_source_check
  CHECK (acquisition_source IS NULL OR acquisition_source IN
    ('google', 'facebook', 'instagram', 'linkedin', 'tiktok', 'sales_consultant', 'friend', 'other'));

-- Points at the EXISTING roster. One list, one source of truth.
ALTER TABLE users ADD COLUMN IF NOT EXISTS acquisition_consultant_id INTEGER
  REFERENCES sales_consultants(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS acquisition_other_text VARCHAR(200);
ALTER TABLE users ADD COLUMN IF NOT EXISTS acquisition_recorded_at TIMESTAMPTZ;

-- --- Assignment: who looks after this member, decided by an admin -----------
ALTER TABLE users ADD COLUMN IF NOT EXISTS assigned_consultant_id INTEGER
  REFERENCES sales_consultants(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS assigned_by INTEGER
  REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_users_assigned_consultant ON users (assigned_consultant_id);
CREATE INDEX IF NOT EXISTS idx_users_acquisition_consultant ON users (acquisition_consultant_id);
CREATE INDEX IF NOT EXISTS idx_users_acquisition_source ON users (acquisition_source);

-- Reassignment moves money, so every change is kept — who moved it, from whom,
-- to whom, and why. A payout dispute six months from now is answerable only if
-- this row exists.
CREATE TABLE IF NOT EXISTS consultant_assignment_history (
  id                 SERIAL PRIMARY KEY,
  user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_consultant_id INTEGER REFERENCES sales_consultants(id) ON DELETE SET NULL,
  to_consultant_id   INTEGER REFERENCES sales_consultants(id) ON DELETE SET NULL,
  admin_user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reason             TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_consultant_assignment_history_user
  ON consultant_assignment_history (user_id, created_at DESC);

-- --- Why a payment credited the consultant it credited ----------------------
--
-- The commission owner itself stays in payments.sales_consultant_id, which is
-- what every existing commission report and payout query already reads. Only
-- the EXPLANATION is new, so none of those had to change.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS consultant_source VARCHAR(20);
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_consultant_source_check;
ALTER TABLE payments ADD CONSTRAINT payments_consultant_source_check
  CHECK (consultant_source IS NULL OR consultant_source IN
    ('admin_assignment', 'member_signup', 'checkout_selection'));

ALTER TABLE orders ADD COLUMN IF NOT EXISTS consultant_source VARCHAR(20);
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_consultant_source_check;
ALTER TABLE orders ADD CONSTRAINT orders_consultant_source_check
  CHECK (consultant_source IS NULL OR consultant_source IN
    ('admin_assignment', 'member_signup', 'checkout_selection'));

-- --- Referral link clicks ---------------------------------------------------
--
-- member_referrals already records referrals that CONVERTED. This records the
-- ones that didn't, which is the only way to see the drop-off between a link
-- being shared and somebody signing up.
CREATE TABLE IF NOT EXISTS referral_clicks (
  id               SERIAL PRIMARY KEY,
  referral_code    VARCHAR(20) NOT NULL,
  referrer_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- Truncated user agent and a coarse referrer only. No IP address is stored:
  -- under POPIA that is personal information, and counting clicks does not
  -- need it.
  user_agent       VARCHAR(200),
  referrer_url     VARCHAR(300),
  converted_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_referral_clicks_code ON referral_clicks (referral_code, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_referral_clicks_referrer ON referral_clicks (referrer_user_id, created_at DESC);

-- --- Share events -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS share_events (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  share_type   VARCHAR(30) NOT NULL,
  entity_id    INTEGER,
  channel      VARCHAR(30),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_share_events_user ON share_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_share_events_type ON share_events (share_type, created_at DESC);
