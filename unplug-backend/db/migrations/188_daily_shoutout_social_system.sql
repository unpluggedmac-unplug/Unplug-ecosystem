-- Daily Shout-Out v2 — deterministic social artwork, immutable share URLs,
-- mascot pose library, drafts and first-party interaction analytics.
--
-- The existing shoutout_schedule remains the source of truth for which person
-- owns a calendar day. These columns freeze the public presentation so a
-- historical share permalink never starts showing tomorrow's person.

ALTER TABLE shoutout_schedule
  ADD COLUMN IF NOT EXISTS recipient_name VARCHAR(200),
  ADD COLUMN IF NOT EXISTS template_version VARCHAR(20) NOT NULL DEFAULT 'v1',
  ADD COLUMN IF NOT EXISTS mascot_pose_key VARCHAR(80) NOT NULL DEFAULT 'power-up',
  ADD COLUMN IF NOT EXISTS share_slug VARCHAR(260),
  ADD COLUMN IF NOT EXISTS share_caption TEXT,
  ADD COLUMN IF NOT EXISTS image_portrait_url TEXT,
  ADD COLUMN IF NOT EXISTS image_square_url TEXT,
  ADD COLUMN IF NOT EXISTS image_og_url TEXT,
  ADD COLUMN IF NOT EXISTS asset_status VARCHAR(20) NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS asset_error TEXT,
  ADD COLUMN IF NOT EXISTS assets_generated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE shoutout_schedule DROP CONSTRAINT IF EXISTS shoutout_schedule_asset_status_check;
ALTER TABLE shoutout_schedule ADD CONSTRAINT shoutout_schedule_asset_status_check
  CHECK (asset_status IN ('pending', 'generating', 'ready', 'failed'));

-- Freeze the recipient name on historical rows. A nomination can still be
-- edited/reviewed later without rewriting the person an old share link showed.
UPDATE shoutout_schedule s
   SET recipient_name = COALESCE(n.nominee_name, s.fallback_name, 'Unplug Community')
  FROM shoutout_nominations n
 WHERE s.recipient_name IS NULL
   AND s.nomination_id = n.id;

UPDATE shoutout_schedule
   SET recipient_name = COALESCE(recipient_name, fallback_name, 'Unplug Community')
 WHERE recipient_name IS NULL;

ALTER TABLE shoutout_schedule ALTER COLUMN recipient_name SET NOT NULL;

-- Backfill deterministic slugs for dates that already ran. The date is unique,
-- so even two people with the same name can never collide.
UPDATE shoutout_schedule
   SET share_slug = to_char(shoutout_date, 'YYYY-MM-DD') || '-' ||
       trim(both '-' from regexp_replace(lower(recipient_name), '[^a-z0-9]+', '-', 'g'))
 WHERE share_slug IS NULL OR share_slug = '';

CREATE UNIQUE INDEX IF NOT EXISTS uq_shoutout_schedule_share_slug
  ON shoutout_schedule (share_slug);
CREATE INDEX IF NOT EXISTS idx_shoutout_schedule_published
  ON shoutout_schedule (shoutout_date DESC, published_at DESC);

-- A pose library instead of one hard-coded mascot. asset_url is optional: the
-- v2 renderer has deterministic built-in vector poses now, while a future
-- uploaded The Guy asset can replace a pose without changing the data model.
CREATE TABLE IF NOT EXISTS shoutout_mascot_poses (
  pose_key     VARCHAR(80) PRIMARY KEY,
  label        VARCHAR(120) NOT NULL,
  asset_url    TEXT,
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO shoutout_mascot_poses (pose_key, label, sort_order) VALUES
  ('power-up', 'Power Up', 10),
  ('megaphone-pointing', 'Megaphone + Pointing', 20),
  ('spark-wave', 'Spark + Wave', 30)
ON CONFLICT (pose_key) DO NOTHING;

-- Drafts are deliberately separate from the live schedule: saving a draft for
-- today must never block the automatic daily pick from materialising.
CREATE TABLE IF NOT EXISTS shoutout_drafts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_date     DATE NOT NULL,
  recipient_name   VARCHAR(200) NOT NULL,
  template_version VARCHAR(20) NOT NULL DEFAULT 'v1',
  mascot_pose_key  VARCHAR(80) NOT NULL DEFAULT 'power-up'
                   REFERENCES shoutout_mascot_poses(pose_key),
  share_caption    TEXT,
  created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shoutout_drafts_updated
  ON shoutout_drafts (updated_at DESC);

-- Aggregate, first-party events only. No fingerprint, visitor identity or
-- additional personal information is stored for this feature.
CREATE TABLE IF NOT EXISTS shoutout_events (
  id             BIGSERIAL PRIMARY KEY,
  shoutout_date  DATE NOT NULL REFERENCES shoutout_schedule(shoutout_date) ON DELETE CASCADE,
  event_type     VARCHAR(80) NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shoutout_events_lookup
  ON shoutout_events (shoutout_date, event_type, created_at DESC);
