-- Central media index for the Admin Media Library.
-- Existing content remains the source of truth for where an image is used;
-- this table catalogues uploads themselves so newly uploaded files can be
-- found and reused even before they are attached to content.

CREATE TABLE IF NOT EXISTS media_assets (
  id            BIGSERIAL PRIMARY KEY,
  url           TEXT NOT NULL UNIQUE,
  filename      TEXT,
  storage       VARCHAR(30),
  mime_type     VARCHAR(120),
  size_bytes    BIGINT,
  width         INTEGER,
  height        INTEGER,
  alt_text      TEXT,
  caption       TEXT,
  uploaded_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  trashed_at    TIMESTAMPTZ,
  trashed_by    INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_media_assets_created ON media_assets (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_assets_active ON media_assets (trashed_at, created_at DESC);
