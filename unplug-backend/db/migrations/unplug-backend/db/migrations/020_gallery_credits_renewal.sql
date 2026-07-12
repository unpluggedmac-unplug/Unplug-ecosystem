-- Unplug Ecosystem — Session F tier perks, part 2: free gallery bundles
-- (Individual Pro/Premium) and the annual renewal date that refreshes
-- every credit type.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS free_gallery_credits SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS renews_at TIMESTAMPTZ;
