-- Multi-signer support for Party B guardians, witnesses and authorised
-- representatives. Each signer may receive a distinct private token without
-- changing or exposing the parent agreement token.

ALTER TABLE agreement_submission_parties
  ADD COLUMN IF NOT EXISTS signing_token VARCHAR(160),
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS verification_channel VARCHAR(20),
  ADD COLUMN IF NOT EXISTS signed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS member_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_agreement_submission_parties_signing_token
  ON agreement_submission_parties(signing_token)
  WHERE signing_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agreement_submission_parties_member
  ON agreement_submission_parties(member_user_id)
  WHERE member_user_id IS NOT NULL;

ALTER TABLE agreement_verification_codes
  ADD COLUMN IF NOT EXISTS party_id BIGINT REFERENCES agreement_submission_parties(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_agreement_verification_party
  ON agreement_verification_codes(party_id,channel,created_at DESC)
  WHERE party_id IS NOT NULL;
