-- Editable advertising banners.
--
-- The ad placeholders on the site ("Reserve this space") were static markup.
-- This lets an admin drop a real banner image and a click-through link into any
-- named slot; the public page swaps the placeholder for the banner when one is
-- set, and shows the placeholder again if the slot is cleared.
--
-- slot_key matches the data-ad-slot attribute on the page (e.g.
-- 'home-sponsor-1', 'news-leaderboard'). The catalog of keys lives in the
-- frontend/admin; this table only holds whatever has actually been filled in,
-- so an unknown or retired key simply has no row and falls back to the
-- placeholder.
CREATE TABLE IF NOT EXISTS ad_slots (
  slot_key   VARCHAR(60) PRIMARY KEY,
  image_url  TEXT NOT NULL,
  link_url   TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
