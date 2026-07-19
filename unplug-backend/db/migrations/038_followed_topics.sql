-- Topics a member follows, used to build their "For you" feed. Stores the
-- category id rather than a name so renaming a category doesn't orphan
-- everyone's follows.
CREATE TABLE IF NOT EXISTS followed_topics (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, category_id)
);

CREATE INDEX IF NOT EXISTS followed_topics_user_idx ON followed_topics (user_id);
