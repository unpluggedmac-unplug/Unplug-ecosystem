-- The Arena's real closing date: 31 October 2026.
--
-- Migration 014 seeded the competition with a placeholder window (now() + 365
-- days), which is why the site was advertising "7 July 2027" — a year from
-- whenever that row happened to be created. This sets the date the magazine
-- actually intends.
--
-- WHY THE GUARD: db/migrate.js re-runs every migration on every deploy. A bare
-- UPDATE here would re-apply forever, so the moment anyone changed the closing
-- date afterwards the next deploy would silently reset it back to 31 October.
-- The marker table makes this a genuine one-off: it runs once, and any later
-- change to the date survives every subsequent deploy.
CREATE TABLE IF NOT EXISTS applied_oneoffs (
  key        TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM applied_oneoffs WHERE key = 'arena_closes_2026_10_31') THEN
    -- End of day in South African time (UTC+2), so the date reads as
    -- 31 October 2026 rather than tipping into the 30th or 1st.
    UPDATE competitions
       SET closes_at = TIMESTAMPTZ '2026-10-31 23:59:59+02'
     WHERE slug = 'the-arena';

    INSERT INTO applied_oneoffs (key) VALUES ('arena_closes_2026_10_31');
  END IF;
END $$;
