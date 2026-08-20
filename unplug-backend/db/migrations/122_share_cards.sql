-- "AS FEATURED IN UNPLUG" SHARE CARDS.
--
-- Somebody we featured makes a card to post on their own social accounts. They
-- see only a watermarked preview until an admin approves it, so nothing goes
-- out carrying the masthead that an editor has not seen.
--
-- NO IMAGE IS STORED. The handover design kept the rendered PNG as base64 in a
-- text column, which meant roughly 700KB of database per card and a purge job
-- to stop the table growing without limit. A card is completely determined by
-- the five fields below, so it can be drawn again from them at any time by the
-- same code that drew the preview. Storing the picture as well as the facts
-- that produce it is storing the same thing twice, and the copy is the
-- expensive one.
--
-- THE APPROVAL LIVES IN THE ADMIN QUEUE, not in an inbox. Every other decision
-- on this site — articles, listings, payments, comments — is made in one
-- place. Approving by clicking a link in an email would put this one decision
-- somewhere else, with its own audit trail, and split "what needs my
-- attention" across two systems.

CREATE TABLE IF NOT EXISTS share_cards (
  id              SERIAL PRIMARY KEY,
  name            VARCHAR(160) NOT NULL,
  role_line       VARCHAR(160),
  quote           VARCHAR(400),
  category        VARCHAR(80),
  -- 'post' is 4:5 for a feed, 'story' is 9:16 for a full-screen story.
  format          VARCHAR(20) NOT NULL DEFAULT 'post'
                  CHECK (format IN ('post', 'story')),

  -- Where the approved card is sent. Required: a card nobody can be given is
  -- not worth reviewing.
  submitter_email VARCHAR(255) NOT NULL,

  status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'approved', 'rejected')),

  -- Unguessable, and the ONLY way to fetch a clean card. Generated per
  -- submission so a link cannot be walked from one card to another the way a
  -- sequential id could.
  review_token    UUID NOT NULL DEFAULT gen_random_uuid(),

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at     TIMESTAMPTZ,
  reviewed_by     INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_share_cards_status ON share_cards (status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_share_cards_token ON share_cards (review_token);
