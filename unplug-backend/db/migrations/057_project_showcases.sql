-- Investors → Project Showcase system. Dedicated tables (per the spec's data
-- model); images/logos live in the existing Supabase upload store, we only keep
-- the URL here. Video is stored as columns on projects (one video per project).

CREATE TABLE IF NOT EXISTS projects (
  id              SERIAL PRIMARY KEY,
  title           VARCHAR(200) NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  status          VARCHAR(20) NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'published', 'unpublished', 'archived')),
  featured        BOOLEAN NOT NULL DEFAULT false,
  display_order   INTEGER NOT NULL DEFAULT 0,
  video_platform  VARCHAR(20) CHECK (video_platform IN ('youtube', 'instagram')),
  video_url       TEXT,
  video_embed_url TEXT,
  seo_title       VARCHAR(200),
  meta_description VARCHAR(400),
  created_by      INTEGER REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects (status);
CREATE INDEX IF NOT EXISTS idx_projects_order ON projects (featured DESC, display_order, id);

CREATE TABLE IF NOT EXISTS project_sponsors (
  id            SERIAL PRIMARY KEY,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          VARCHAR(160) NOT NULL,
  logo_url      TEXT,
  link_type     VARCHAR(20) NOT NULL DEFAULT 'website'
                  CHECK (link_type IN ('website', 'facebook', 'instagram')),
  link_url      TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_project_sponsors_project ON project_sponsors (project_id, display_order, id);

CREATE TABLE IF NOT EXISTS project_images (
  id            SERIAL PRIMARY KEY,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  image_url     TEXT NOT NULL,
  alt_text      VARCHAR(255),
  caption       VARCHAR(255),
  display_order INTEGER NOT NULL DEFAULT 0,
  is_cover      BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_project_images_project ON project_images (project_id, display_order, id);
