-- Failed sign-in attempts, so an account can be defended and not just an IP.
--
-- WHY THE EXISTING RATE LIMIT IS NOT ENOUGH. express-rate-limit keys on the
-- IP: ten tries per quarter hour from one address. An attacker with a hundred
-- addresses gets a thousand tries at one account and never touches the limit,
-- because no single address exceeds it. Password spraying works exactly this
-- way, and the current defence cannot see it.
--
-- WHY THIS IS NOT A HARD LOCKOUT. "Five failures and the account is locked"
-- hands anyone who knows an email address the ability to lock its owner out at
-- will — a denial of service delivered through the security feature. So this
-- delays instead: each failure makes the next attempt wait longer, doubling to
-- a cap. Guessing becomes arithmetically hopeless while a real person who
-- mistyped their password waits seconds, not hours, and can still reset it.
--
-- A SUCCESSFUL SIGN-IN CLEARS THE COUNT. Failures are evidence of guessing
-- only until the real owner arrives.
--
-- Reversal: DROP TABLE login_attempts. Login returns to IP-only limiting.

CREATE TABLE IF NOT EXISTS login_attempts (
  -- Lower-cased email. Not a foreign key to users(id) on purpose: attempts
  -- against an address that does not exist are exactly as interesting as
  -- attempts against one that does, and a FK would silently discard them.
  -- Storing the address that was TRIED is also what makes it possible to see
  -- somebody working through a list.
  identifier     TEXT PRIMARY KEY,

  failed_count   INTEGER NOT NULL DEFAULT 0,
  first_failed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_failed_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- When the next attempt may be made. NULL means right now.
  blocked_until  TIMESTAMPTZ,

  -- The last address seen failing against this identifier. One address
  -- failing repeatedly is somebody who forgot their password; many different
  -- addresses failing against one account is an attack, and the two deserve
  -- different attention.
  last_ip        TEXT,
  distinct_ips   INTEGER NOT NULL DEFAULT 0,

  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The admin view: who is currently being worked on, worst first.
CREATE INDEX IF NOT EXISTS idx_login_attempts_blocked
  ON login_attempts (blocked_until DESC NULLS LAST)
  WHERE blocked_until IS NOT NULL;

-- The cleanup job needs to find stale rows.
CREATE INDEX IF NOT EXISTS idx_login_attempts_last_failed
  ON login_attempts (last_failed_at);
