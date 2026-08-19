-- The live Google Analytics 4 property for unplugnews.com.
--
-- 118 seeded this key empty, which is the correct default: a tag pointing at
-- no property looks like it is working. The real ID is supplied here so
-- Google Analytics is on without anyone having to paste it into a form.
--
-- APPLIED EXACTLY ONCE, EVER. Migrations re-run on every deploy, so a plain
-- UPDATE would silently reinstate this value every time — meaning an admin who
-- later changed the ID, or cleared it to switch Google off, would find their
-- decision undone by the next unrelated deploy. The marker row below is what
-- makes this a one-time seed rather than a setting that keeps reasserting
-- itself. See the "seed, don't surprise" rule this codebase already follows
-- for badges and price settings.
--
-- To change or disable Google Analytics from here on, use
-- Admin -> Analytics -> Google Analytics. Clearing that field stops the tag
-- being loaded at all, and this migration will not put it back.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM settings WHERE key = 'ga4_id_seeded') THEN
    UPDATE settings SET value = 'G-7CNWS63ZHD', updated_at = now()
     WHERE key = 'ga4_measurement_id';

    INSERT INTO settings (key, value) VALUES ('ga4_id_seeded', 'G-7CNWS63ZHD')
    ON CONFLICT (key) DO NOTHING;
  END IF;
END $$;
