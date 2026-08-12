-- Linking an existing Directory listing to a member's Passport account.
--
-- These are two separate things and stay two separate things. A Passport
-- Profile is the member's own account and dashboard; a Directory listing is a
-- paid service. Creating an account does not create a listing, and buying any
-- other Unplug service has never required one. What was missing is the
-- ability to say "this listing, which we captured before this person had an
-- account, belongs to them" — and to undo that if the wrong one is picked.
--
-- The link itself is profiles.user_id, which already exists and is already
-- UNIQUE per user. Nothing new is invented to hold it, because a second
-- linking table alongside a column that already means the same thing is how
-- two sources of truth start disagreeing.
--
-- What IS new is the history. Re-pointing profiles.user_id is a transfer of
-- ownership of something somebody paid for; done blind it is unrecoverable,
-- because the previous owner's id is simply overwritten. Every link records
-- where the listing came from, so it can be put back.

CREATE TABLE IF NOT EXISTS profile_link_history (
  id            SERIAL PRIMARY KEY,
  profile_id    INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  -- Nullable: SET NULL on user deletion, so history survives the account
  -- going away rather than the row disappearing with it.
  from_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  to_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  admin_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reason        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_profile_link_history_profile
  ON profile_link_history (profile_id, created_at DESC);
