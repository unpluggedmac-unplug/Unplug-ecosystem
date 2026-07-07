-- Unplug Ecosystem — Phase 3, Step 12: Email Verification, Password Reset, Digital Signatures
-- Depends on 001_users.sql through 008_settings_bundle_vote.sql having already run.

ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS alt_email VARCHAR(255);

-- Signup verification codes (the "two-step verification at signup").
-- A 6-digit code emailed at registration; the account can't log in until
-- it's confirmed. Codes expire and are single-use.
CREATE TABLE IF NOT EXISTS email_verification_codes (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code          VARCHAR(6) NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  used_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_verification_user ON email_verification_codes (user_id);

-- Forgot-password tokens — random, single-use, short-lived. Sent to the
-- account's email OR alt_email (whichever the user picks).
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token         VARCHAR(128) NOT NULL UNIQUE,
  expires_at    TIMESTAMPTZ NOT NULL,
  used_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reset_token ON password_reset_tokens (token);

-- Digital signatures — a lightweight but real audit trail: who signed,
-- what they signed (type + version, so wording changes don't silently
-- apply to people who signed an older version), how (typed full name
-- taken as their signature), and enough metadata (IP, user agent,
-- timestamp) to stand behind it if ever disputed. Protects both the
-- signer and Unplug.
CREATE TABLE IF NOT EXISTS signed_agreements (
  id                SERIAL PRIMARY KEY,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agreement_type    VARCHAR(40) NOT NULL
                    CHECK (agreement_type IN ('directory_terms', 'investor_agreement', 'advertiser_terms', 'competition_rules')),
  agreement_version VARCHAR(20) NOT NULL,
  signed_name       VARCHAR(160) NOT NULL,
  ip_address        VARCHAR(64),
  user_agent        VARCHAR(500),
  signed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, agreement_type, agreement_version)
);
CREATE INDEX IF NOT EXISTS idx_signed_user ON signed_agreements (user_id);
