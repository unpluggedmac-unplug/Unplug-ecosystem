-- Passwordless sign-in links. Modelled on password_reset_tokens, but with a
-- much shorter life: a reset code is something you go and fetch, whereas a
-- sign-in link is used within a minute or two of asking for it, so 15
-- minutes is generous and keeps the window for a leaked link small.
CREATE TABLE IF NOT EXISTS magic_link_tokens (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      VARCHAR(128) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_magic_link_token ON magic_link_tokens (token);
-- Used to cap how many links one account can request in a window.
CREATE INDEX IF NOT EXISTS idx_magic_link_user ON magic_link_tokens (user_id, created_at DESC);
