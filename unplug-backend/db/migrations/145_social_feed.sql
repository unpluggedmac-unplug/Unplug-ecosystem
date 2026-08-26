-- The social feed: posts an admin puts in by hand.
--
-- WHY THERE IS NO API HERE. The obvious build is Instagram's Basic Display
-- API, and it was switched off on 4 December 2024. Its replacement, the
-- Instagram Graph API, needs a Business or Creator account linked to a
-- Facebook Page, a Meta app, and Meta's app review — none of which this
-- codebase can arrange for itself — and it hands back a token that expires
-- every sixty days. The failure mode of that token quietly lapsing is a feed
-- that empties itself one morning with nothing in any log to say why, which
-- on a magazine's homepage looks like the site has been abandoned.
--
-- So: an admin pastes the link, the picture and the caption. It is more work
-- per post and it cannot break on its own.
--
-- IF AN AUTOMATIC FEED IS WANTED LATER, this table is the right shape for it:
-- a fetcher would write these same rows on a schedule and the frontend would
-- not change at all. That is the reason for `source` — 'manual' today, room
-- for 'instagram' later without a migration that has to move data.
--
-- Reversal: drop the table. The frontend widget renders nothing when the
-- endpoint returns an empty list, which is also what it does today.

CREATE TABLE IF NOT EXISTS social_posts (
  id          SERIAL PRIMARY KEY,

  -- Where it came from, so an automatic fetcher can be added later without
  -- being unable to tell its rows from the hand-entered ones.
  source      VARCHAR(20) NOT NULL DEFAULT 'manual'
              CHECK (source IN ('manual', 'instagram', 'facebook', 'tiktok')),

  -- The post itself. permalink is what a reader is sent to.
  permalink   TEXT NOT NULL,
  image_url   TEXT,
  caption     TEXT,

  -- Which account it was posted by, for the label on the card. Free text
  -- rather than a foreign key: this may be the magazine's own account, or a
  -- member's, or a sponsor's.
  handle      VARCHAR(80),

  -- When it was posted, which is not when it was entered. A feed ordered by
  -- data-entry time shows last week's post above yesterday's simply because
  -- somebody caught up on a Friday.
  posted_at   TIMESTAMPTZ,

  -- OFF UNTIL SOMEBODY SAYS OTHERWISE, the same rule as popups and email
  -- automations. Half-entered rows must not appear on the homepage.
  active      BOOLEAN NOT NULL DEFAULT false,

  -- Manual ordering, for pinning something to the front. Ties fall back to
  -- posted_at, so leaving this alone gives a sensible feed on its own.
  position    INTEGER NOT NULL DEFAULT 0,

  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_social_posts_live
  ON social_posts (active, position DESC, posted_at DESC);

-- One post per permalink. Stops the same thing being entered twice by two
-- people, and gives a future fetcher something to ON CONFLICT against so it
-- can re-run without duplicating the feed every time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_social_posts_permalink ON social_posts (permalink);
