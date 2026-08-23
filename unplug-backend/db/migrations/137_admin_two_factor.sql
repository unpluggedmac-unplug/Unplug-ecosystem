-- Two-factor authentication for admin accounts.
--
-- WHY ADMINS ONLY. A stolen member password costs that member their account.
-- A stolen admin password costs every article, every payment record and every
-- profile on the site. Requiring a second factor from readers would cost
-- sign-ups and protect very little; requiring it from admins is the whole win
-- for four people.
--
-- SET UP, THEN CONFIRMED, THEN ON. The secret is stored the moment somebody
-- starts enrolling, but two_factor_enabled stays false until they have proved
-- they can produce a code from it. Otherwise a mistyped setup — a scanner that
-- did not read the QR code properly, an app pointed at the wrong account —
-- locks the admin out of the site at the next sign-in, and the person who
-- would fix that is them.
--
-- Reversal: the columns can be dropped, or every row set to false, and login
-- returns to a password alone.

ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_secret TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_confirmed_at TIMESTAMPTZ;

-- Single-use codes for the day the phone is lost or replaced.
--
-- Stored HASHED, exactly like a password. A recovery code is a password: it is
-- one string that gets somebody past the second factor. Storing them in plain
-- text would mean a read of this table hands over every admin's way in.
CREATE TABLE IF NOT EXISTS two_factor_recovery_codes (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_2fa_recovery_user
  ON two_factor_recovery_codes (user_id) WHERE used_at IS NULL;

-- A TOTP code is valid for a thirty-second window, which means a code
-- intercepted in that window can be replayed. Remembering the last one used
-- closes that: the same code cannot be presented twice for the same account.
ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_last_token TEXT;
