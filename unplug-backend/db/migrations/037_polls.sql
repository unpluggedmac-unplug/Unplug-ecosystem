-- Reader polls. A poll can be attached to an article (shows inside that
-- story) or left unattached (article_id NULL) to run site-wide.
CREATE TABLE IF NOT EXISTS polls (
  id         SERIAL PRIMARY KEY,
  question   TEXT NOT NULL,
  article_id INTEGER REFERENCES articles(id) ON DELETE CASCADE,
  is_open    BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS poll_options (
  id       SERIAL PRIMARY KEY,
  poll_id  INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  label    TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS poll_options_poll_idx ON poll_options (poll_id, position);
CREATE INDEX IF NOT EXISTS polls_article_idx ON polls (article_id);

-- Votes. Polls are open to everyone (not just members), so we can't key on a
-- user id alone. voter_key is the member id when signed in, otherwise a
-- random id the browser stores — a soft guard against casual double-voting,
-- not a hard identity check. The unique index is what actually enforces
-- one vote per voter per poll.
CREATE TABLE IF NOT EXISTS poll_votes (
  id         SERIAL PRIMARY KEY,
  poll_id    INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  option_id  INTEGER NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
  voter_key  TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS poll_votes_one_per_voter
  ON poll_votes (poll_id, voter_key);
CREATE INDEX IF NOT EXISTS poll_votes_option_idx ON poll_votes (option_id);
