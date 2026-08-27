-- 153: South African Sign Language, as signed video.
--
-- SASL IS NOT A WRITTEN LANGUAGE. There is no string to put in a translation
-- dictionary for it, and anything that looked like one would be wrong. It
-- belongs on this site as video of a person signing, with captions — recorded
-- by a signer, never generated.
--
-- That is why this is a table of videos and not a column in i18n.js.
--
-- One row per thing explained, keyed the same way `highlights` is keyed
-- (target_type + target_id), so one mechanism covers both an article and a
-- standing page rather than two that drift apart.

CREATE TABLE IF NOT EXISTS sasl_videos (
  id            SERIAL PRIMARY KEY,
  target_type   VARCHAR(20) NOT NULL CHECK (target_type IN ('article', 'page')),
  -- TEXT, not an integer: an article target is an id, a page target is a page
  -- name like 'deafcommunity'. One column that holds both beats two nullable
  -- ones that have to be kept in step.
  target_id     VARCHAR(80) NOT NULL,

  video_url     VARCHAR(500) NOT NULL,
  -- Filled in for a YouTube/Vimeo link so the front end does not have to work
  -- out how to play it; null for a direct file, which plays in <video>.
  embed_url     VARCHAR(500),
  platform      VARCHAR(20),
  poster_url    VARCHAR(500),

  -- CAPTIONS ARE STORED AS TEXT, NOT AS A FILE.
  --
  -- A .vtt would need the upload endpoint to accept a new file type and the
  -- storage bucket to serve it with the right content type. Keeping the cue
  -- text in the database avoids both, and the browser is handed a blob URL for
  -- the <track>. It also means captions can be corrected in the admin without
  -- re-uploading anything.
  --
  -- Captions are NOT optional in spirit. A signed video with no captions
  -- excludes every deaf person who does not sign, and every hearing person
  -- watching without sound.
  captions_vtt  TEXT,

  signer_name   VARCHAR(160),
  note          VARCHAR(300),

  -- OFF WHEN CREATED, like popups, automations, social posts and forms. A
  -- half-recorded video must not appear on a live article because somebody
  -- saved a draft row.
  is_published  BOOLEAN NOT NULL DEFAULT false,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One video per thing. Two would be an editorial accident, not a feature.
  UNIQUE (target_type, target_id)
);

CREATE INDEX IF NOT EXISTS idx_sasl_videos_lookup
  ON sasl_videos (target_type, target_id) WHERE is_published = true;
