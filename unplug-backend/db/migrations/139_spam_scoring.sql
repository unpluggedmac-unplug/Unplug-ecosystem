-- Spam scoring: what was judged, why, and what a moderator decided afterwards.
--
-- WHAT THIS IS ACTUALLY FOR. Every public submission on this site already goes
-- to a moderation queue with status 'pending'. Spam is not reaching readers
-- today. What it IS doing is burying the real submissions — a nomination from
-- somebody's grandmother sits behind forty pieces of casino spam, and the
-- moderator who has to wade through that is the reason good entries get
-- missed.
--
-- So this does not exist to block. It exists to SORT, and to let a moderator
-- see the twelve real ones first.
--
-- NOTHING IS EVER SILENTLY DELETED. Every assessment is recorded with the
-- signals that produced it, and the highest confidence outcome is still a row
-- somebody can find and reverse. In a community magazine, a genuine entry
-- vanishing without trace is a worse failure than spam reaching a queue: the
-- person who submitted it will never know, and neither will we.
--
-- Reversal: DROP TABLE spam_assessments, spam_tokens. Submissions go back to
-- arriving unsorted, which is how they arrive today.

CREATE TABLE IF NOT EXISTS spam_assessments (
  id            SERIAL PRIMARY KEY,

  -- What was submitted, so an assessment can be traced back to the thing it
  -- judged. Deliberately loose (no foreign key) because submissions live in a
  -- dozen tables — inquiries, shoutout nominations, comments, birthdays, jobs
  -- — and a key per table would be a dozen columns, eleven of them always null.
  target_type   VARCHAR(40) NOT NULL,
  target_id     INTEGER,

  score         INTEGER NOT NULL,
  -- 'clean', 'suspect' or 'spam'. The name of a verdict, not a fate: a
  -- 'spam' verdict still leaves the submission recoverable.
  verdict       VARCHAR(10) NOT NULL CHECK (verdict IN ('clean', 'suspect', 'spam')),

  -- Which signals fired and what each contributed, as JSON. This is the part
  -- that matters when somebody asks "why was my message flagged?" — a score
  -- with no explanation is not something anyone can argue with or improve.
  signals       JSONB NOT NULL DEFAULT '[]',

  -- Kept for the classifier to learn from, and for a moderator to read when
  -- deciding. Trimmed, not the whole essay.
  sample        TEXT,
  email         TEXT,
  ip_address    TEXT,

  -- What a human decided in the end, once they looked. NULL means nobody has.
  -- This is the training signal: the difference between what the scorer
  -- thought and what a person concluded.
  moderator_verdict VARCHAR(10) CHECK (moderator_verdict IN ('ham', 'spam')),
  moderated_by  INTEGER REFERENCES users(id),
  moderated_at  TIMESTAMPTZ,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_spam_assessments_created ON spam_assessments (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_spam_assessments_verdict ON spam_assessments (verdict, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_spam_assessments_target  ON spam_assessments (target_type, target_id);
-- The false-positive review: things the scorer called spam that a person did not.
CREATE INDEX IF NOT EXISTS idx_spam_assessments_disagreement
  ON spam_assessments (created_at DESC)
  WHERE moderator_verdict IS NOT NULL;

-- Word counts for the classifier.
--
-- A word seen mostly in submissions moderators rejected raises the score of
-- the next submission containing it; a word seen mostly in approved ones
-- lowers it. That is the whole idea, and it beats any keyword list somebody
-- writes by hand, because it learns THIS site's spam rather than spam in
-- general — the words that mark a fake nomination here are not the words that
-- mark a fake comment elsewhere.
CREATE TABLE IF NOT EXISTS spam_tokens (
  token       VARCHAR(40) PRIMARY KEY,
  spam_count  INTEGER NOT NULL DEFAULT 0,
  ham_count   INTEGER NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Only tokens with enough evidence are worth consulting; this supports the
-- query that skips the rest.
CREATE INDEX IF NOT EXISTS idx_spam_tokens_total
  ON spam_tokens ((spam_count + ham_count) DESC);

-- Sensitivity, in the existing settings table rather than a new one.
--
-- Seeded HIGH on purpose, meaning "only be confident about the obvious". A
-- filter that starts aggressive loses real submissions in its first week, and
-- nobody ever finds out which ones. Tightening later is a decision somebody
-- makes on evidence from the dashboard; starting tight is a decision made
-- with none.
INSERT INTO settings (key, value) VALUES ('spam_suspect_threshold', '40')
  ON CONFLICT (key) DO NOTHING;
INSERT INTO settings (key, value) VALUES ('spam_reject_threshold', '80')
  ON CONFLICT (key) DO NOTHING;
-- Whether a 'spam' verdict may auto-reject at all, or whether everything is
-- queued for a person regardless. Off by default: on a site this size a
-- moderator can read everything, and the cost of an unseen false positive is
-- higher than the cost of a moment's reading.
INSERT INTO settings (key, value) VALUES ('spam_autoreject_enabled', 'false')
  ON CONFLICT (key) DO NOTHING;
