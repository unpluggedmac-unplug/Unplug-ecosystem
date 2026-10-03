-- Password reset now uses a 6-digit code paired with the requesting email.
-- A six-digit space is intentionally small enough for a human to type, so the
-- code must NOT be globally unique forever. The email + active token row is
-- the identity; old random hex tokens remain valid during the transition.

ALTER TABLE password_reset_tokens
  DROP CONSTRAINT IF EXISTS password_reset_tokens_token_key;

DROP INDEX IF EXISTS idx_reset_token;

CREATE INDEX IF NOT EXISTS idx_reset_user_token
  ON password_reset_tokens (user_id, token);

CREATE INDEX IF NOT EXISTS idx_reset_active_lookup
  ON password_reset_tokens (token, expires_at)
  WHERE used_at IS NULL;
