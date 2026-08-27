-- 152: the consent record, and the policy version it was given against.
--
-- Analytics has been consent-gated since migration 029 and that part works.
-- What was missing is the RECORD: POPIA expects you to be able to show that a
-- person consented, WHEN, and TO WHAT — and "the browser has a localStorage
-- key set to accepted" is not evidence of anything. It lives on their device,
-- we cannot see it, and it says nothing about which version of the policy was
-- on the screen when they agreed.
--
-- One row per decision, kept. A withdrawal is a new row saying 'declined',
-- never an update or a delete: the fact that somebody once consented and later
-- changed their mind is exactly the history this table exists to hold.

CREATE TABLE IF NOT EXISTS consent_records (
  id             SERIAL PRIMARY KEY,
  -- Null for a visitor who has no account. Consent is given by people, not by
  -- logins, and most of the site is readable without one.
  user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- The anonymous per-browser id the analytics tracker already mints AFTER
  -- consent. Nullable, and deliberately not derived from anything about the
  -- person — it exists to tie a withdrawal to the acceptance it reverses.
  visitor_key    VARCHAR(64),
  choice         VARCHAR(10) NOT NULL CHECK (choice IN ('accepted', 'declined')),
  -- WHAT they agreed to. Without this the record proves nothing the day the
  -- policy is reworded.
  policy_version VARCHAR(32) NOT NULL,
  -- Which surface asked. 'bar' is the consent dialog; kept open for later.
  source         VARCHAR(20) NOT NULL DEFAULT 'bar',
  user_agent     VARCHAR(400),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- NO IP ADDRESS COLUMN, ON PURPOSE. An IP is personal information under POPIA,
-- and storing one to prove consent to collect anonymous analytics would
-- collect more about the person than the thing they were consenting to. The
-- user agent is kept because it is what distinguishes two decisions from the
-- same household on the same day, and it is not an identifier on its own.

CREATE INDEX IF NOT EXISTS idx_consent_records_user
  ON consent_records (user_id, created_at DESC) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_consent_records_visitor
  ON consent_records (visitor_key, created_at DESC) WHERE visitor_key IS NOT NULL;

-- Bump this whenever the privacy policy changes in a way that people should be
-- asked about again. The consent bar re-asks anybody whose recorded version is
-- older than this one.
INSERT INTO settings (key, value)
VALUES ('privacy_policy_version', '2026-08-27')
ON CONFLICT (key) DO NOTHING;
