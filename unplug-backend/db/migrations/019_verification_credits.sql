-- Unplug Ecosystem — Session F tier perks: verification badge + per-cycle
-- free credits (Article/Event/Arena), granted on profile approval.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS verified BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS verification_note VARCHAR(255);
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS free_article_credits SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS free_event_credits SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS free_arena_credits SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS credits_renewed_at TIMESTAMPTZ;
