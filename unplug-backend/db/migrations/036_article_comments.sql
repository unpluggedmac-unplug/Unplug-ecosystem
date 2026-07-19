-- Comments on articles, with moderation. Unlike the public passport comments
-- (029), these are tied to a member account so there's always someone
-- accountable behind a comment, and nothing appears publicly until an admin
-- approves it.
CREATE TABLE IF NOT EXISTS article_comments (
  id         SERIAL PRIMARY KEY,
  article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ
);

-- Public reads are always "approved comments on this article, oldest first";
-- the moderation queue is always "pending, oldest first".
CREATE INDEX IF NOT EXISTS article_comments_public_idx
  ON article_comments (article_id, status, created_at);
CREATE INDEX IF NOT EXISTS article_comments_queue_idx
  ON article_comments (status, created_at);

-- Reactions. One reaction per member per comment — the composite primary key
-- makes a repeat reaction an update rather than a duplicate, so the counts
-- can't be inflated by clicking twice.
CREATE TABLE IF NOT EXISTS article_comment_reactions (
  comment_id INTEGER NOT NULL REFERENCES article_comments(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reaction   TEXT NOT NULL CHECK (reaction IN ('like', 'love', 'clap', 'insightful')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (comment_id, user_id)
);

CREATE INDEX IF NOT EXISTS article_comment_reactions_comment_idx
  ON article_comment_reactions (comment_id);
