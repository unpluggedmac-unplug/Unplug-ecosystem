-- 151: the free-account gate.
--
-- An article can be marked as needing a (free) account to read in full.
-- Everyone still gets a preview; signing in costs nothing and unlocks it.
--
-- OFF BY DEFAULT, PER ARTICLE. `requires_account` defaults to false, so this
-- migration changes the behaviour of exactly nothing already published. Gating
-- is an editorial decision made one article at a time, not something that
-- happens to the archive because a column was added. Same seed-don't-surprise
-- rule as popups, automations and forms.
ALTER TABLE articles
  ADD COLUMN IF NOT EXISTS requires_account BOOLEAN NOT NULL DEFAULT false;

-- Cards, lists and search all need to know whether a piece is gated, and they
-- ask for it constantly. Partial index: the gated set is the small one.
CREATE INDEX IF NOT EXISTS idx_articles_requires_account
  ON articles (requires_account) WHERE requires_account = true;

-- How much of a gated article a signed-out reader gets, in words.
--
-- Read SERVER-SIDE ONLY. It deliberately never reaches the browser, because
-- the truncation has to happen before the text is sent — a preview enforced in
-- the client is not a gate, it is a CSS trick with the whole article sitting
-- underneath it in the page source.
--
-- 120 words is roughly the first two paragraphs: enough to know whether the
-- piece is worth an account, not enough to be the piece.
INSERT INTO settings (key, value)
VALUES ('gate_preview_words', '120')
ON CONFLICT (key) DO NOTHING;
