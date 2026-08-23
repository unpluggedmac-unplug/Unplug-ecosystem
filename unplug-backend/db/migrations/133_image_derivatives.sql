-- Which stored images have responsive derivatives, and which do not.
--
-- WHY A TABLE AND NOT A COLUMN. Image URLs live in eleven differently-named
-- columns spread across the schema — feature_image_url, banner_image_url,
-- cover_image_url, photo_url, manual_image_url and more. Adding a "variants"
-- column beside each one would be a dozen migrations, a dozen places to keep
-- in step, and a guarantee that some of them drift. Nothing in those tables
-- changes; this records, separately, what exists in storage.
--
-- WHY IT IS NEEDED AT ALL, given that derivative names are deterministic:
-- a browser given a srcset entry that 404s shows a broken image. It does not
-- fall back. So the frontend may only offer a derivative it KNOWS was made,
-- and this is the list. An image absent from here is served exactly as it is
-- today — which is why this can ship before a single old image is converted.
--
-- Reversal: DROP TABLE image_derivatives. The site returns to serving
-- originals, because that is all the frontend does for anything not listed.

CREATE TABLE IF NOT EXISTS image_derivatives (
  -- The storage object key of the ORIGINAL, e.g.
  -- "1785674547722-273def9f7180ef0d4a6871a3ff4bc306.png". Not the full URL:
  -- the Supabase project host appears in every URL and would be repeated on
  -- every row, and it changes if the project ever moves.
  object_key    TEXT PRIMARY KEY,

  -- The widths actually generated, ascending. Usually the standard ladder,
  -- but a narrow source produces a shorter list, so it is recorded per image
  -- rather than assumed.
  widths        INTEGER[] NOT NULL,

  -- The formats generated, e.g. {avif,webp}. Recorded so a future format can
  -- be added to new uploads without the frontend offering it for old ones.
  formats       TEXT[]    NOT NULL,

  -- What the exercise saved. Two different numbers, because they answer two
  -- different questions and conflating them flatters the result:
  --
  --   derivative_bytes is every derivative added up — the STORAGE cost, which
  --     can legitimately exceed the original, since one picture becomes eight
  --     files.
  --   delivered_bytes is the largest AVIF alone — what a reader on a wide
  --     screen actually downloads INSTEAD of the original, and therefore the
  --     only honest measure of whether the page got lighter.
  original_bytes    BIGINT,
  derivative_bytes  BIGINT,

  -- Intrinsic size of the source, so the frontend can set width/height on the
  -- img and stop the page shifting as pictures land. The live site scores
  -- 0.343 CLS on mobile, nearly all of it one unsized image.
  source_width  INTEGER,
  source_height INTEGER,

  -- Populated when derivatives were deliberately NOT made — an animated GIF,
  -- an unreadable file. A row with a reason is a decision on the record; no
  -- row at all just means "not looked at yet", and the two must be tellable
  -- apart or the backfill will retry the same broken file forever.
  skipped_reason TEXT,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The backfill works oldest-first and needs to find what it has not done yet.
CREATE INDEX IF NOT EXISTS idx_image_derivatives_created
  ON image_derivatives (created_at DESC);

-- Re-running the pipeline over an image must update the row rather than fail,
-- so a re-encode at better settings is a safe operation to repeat.
ALTER TABLE image_derivatives ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE image_derivatives ADD COLUMN IF NOT EXISTS delivered_bytes BIGINT;
