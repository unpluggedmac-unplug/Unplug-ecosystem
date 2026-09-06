-- Phase 6 — staged Page & Layout editing.
-- Keeps admin drafts separate from the live page_content/page_blocks tables so
-- a page can be reviewed before publication. The public CMS endpoint remains
-- unchanged and therefore never exposes a draft accidentally.
CREATE TABLE IF NOT EXISTS page_cms_drafts (
  page_key       VARCHAR(60) PRIMARY KEY,
  content_json   JSONB NOT NULL DEFAULT '{}'::jsonb,
  blocks_json    JSONB NOT NULL DEFAULT '[]'::jsonb,
  base_state     JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS page_cms_drafts_updated_idx
  ON page_cms_drafts (updated_at DESC);
