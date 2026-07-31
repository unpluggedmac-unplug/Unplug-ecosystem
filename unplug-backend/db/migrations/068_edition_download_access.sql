-- Edition downloads: guest purchases, EFT references, and single-use access.
--
-- 011 created edition_purchases as "this logged-in user paid for this edition".
-- Selling to someone without an account, taking EFT, and enforcing one download
-- per purchase all need more than that.
ALTER TABLE edition_purchases ADD COLUMN IF NOT EXISTS customer_email     VARCHAR(255);
ALTER TABLE edition_purchases ADD COLUMN IF NOT EXISTS customer_name      VARCHAR(160);
ALTER TABLE edition_purchases ADD COLUMN IF NOT EXISTS amount             NUMERIC(10,2);
ALTER TABLE edition_purchases ADD COLUMN IF NOT EXISTS payment_method     VARCHAR(20);
ALTER TABLE edition_purchases ADD COLUMN IF NOT EXISTS payment_status     VARCHAR(30);
ALTER TABLE edition_purchases ADD COLUMN IF NOT EXISTS download_reference VARCHAR(10);
ALTER TABLE edition_purchases ADD COLUMN IF NOT EXISTS download_token     VARCHAR(64);
ALTER TABLE edition_purchases ADD COLUMN IF NOT EXISTS download_count     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE edition_purchases ADD COLUMN IF NOT EXISTS download_status    VARCHAR(20) NOT NULL DEFAULT 'available';
ALTER TABLE edition_purchases ADD COLUMN IF NOT EXISTS approved_at        TIMESTAMPTZ;
ALTER TABLE edition_purchases ADD COLUMN IF NOT EXISTS approved_by        INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE edition_purchases ADD COLUMN IF NOT EXISTS rejected_reason    TEXT;
ALTER TABLE edition_purchases ADD COLUMN IF NOT EXISTS created_at         TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE edition_purchases ADD COLUMN IF NOT EXISTS updated_at         TIMESTAMPTZ NOT NULL DEFAULT now();

-- Someone buying without an account has no user_id.
ALTER TABLE edition_purchases ALTER COLUMN user_id DROP NOT NULL;

-- The old UNIQUE (user_id, edition_id) has to go. It was right when a purchase
-- meant permanent access, but a download is single-use now: once a member has
-- used theirs, buying the same edition again is a legitimate second purchase
-- and that constraint would block it. It also can't express guest rows.
--
-- NOTE: payments.js used to rely on this for its ON CONFLICT clause; it now
-- approves the pending purchase by id instead.
ALTER TABLE edition_purchases DROP CONSTRAINT IF EXISTS edition_purchases_user_id_edition_id_key;

-- Backfill anything bought under the old model: it was paid, and still works.
UPDATE edition_purchases SET payment_status = 'approved' WHERE payment_status IS NULL;
UPDATE edition_purchases SET payment_method = 'online'   WHERE payment_method IS NULL;
UPDATE edition_purchases ep
   SET customer_email = u.email
  FROM users u
 WHERE ep.user_id = u.id AND ep.customer_email IS NULL;

ALTER TABLE edition_purchases DROP CONSTRAINT IF EXISTS edition_purchases_payment_status_check;
ALTER TABLE edition_purchases ADD CONSTRAINT edition_purchases_payment_status_check
  CHECK (payment_status IN ('awaiting_payment', 'awaiting_eft', 'pending_approval', 'approved', 'rejected', 'cancelled'));

ALTER TABLE edition_purchases DROP CONSTRAINT IF EXISTS edition_purchases_download_status_check;
ALTER TABLE edition_purchases ADD CONSTRAINT edition_purchases_download_status_check
  CHECK (download_status IN ('available', 'used', 'revoked'));

-- The reference is what a customer types to claim their download, and the token
-- is what the download URL carries. Both must be unique — the database enforces
-- it rather than trusting the generator not to collide.
--
-- Partial indexes: rows predating this migration have neither, and several
-- NULLs must not count as duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS idx_edition_purchase_reference
  ON edition_purchases (download_reference) WHERE download_reference IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_edition_purchase_token
  ON edition_purchases (download_token) WHERE download_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_edition_purchase_status
  ON edition_purchases (payment_status, created_at DESC);
-- Claiming looks a purchase up by reference AND email together.
CREATE INDEX IF NOT EXISTS idx_edition_purchase_email
  ON edition_purchases (lower(customer_email));

-- Every download attempt, successful or not. Kept deliberately small: what was
-- downloaded, by which purchase, when, and whether it succeeded. No IP or
-- user-agent — POPIA says collect what you actually need, and for "was this
-- download used" the answer is none of that.
CREATE TABLE IF NOT EXISTS edition_downloads (
  id            SERIAL PRIMARY KEY,
  purchase_id   INTEGER NOT NULL REFERENCES edition_purchases(id) ON DELETE CASCADE,
  edition_id    INTEGER REFERENCES editions(id) ON DELETE SET NULL,
  outcome       VARCHAR(20) NOT NULL,   -- delivered | failed
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_edition_downloads_purchase ON edition_downloads (purchase_id);
