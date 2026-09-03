-- Advertising Banner gets a 21-day tier, matching the four-tier shape every
-- other duration-based service already uses (Article Highlight and Directory
-- Highlight both run 7/14/21/28). Banner was the one outlier at 7/14/28.
--
-- QA punch list 2026-09-03, task 4/6. This is an ADDITION, not a price change:
-- it does not touch the 7/14/28-day rows, and does not collide with any of
-- the 8 pricing decisions frozen in docs/pricing-comparison.md (the spec's
-- only banner figure, R1,000 for 28 days, is untouched by this).
--
-- PRICE: R785. Not a spec figure — none exists for a 21-day banner tier — so
-- derived the same way the site owner reasoned about it: interpolating the
-- per-day rate between the existing 14-day (R550 = R39.29/day) and 28-day
-- (R1,000 = R35.71/day) rows gives ~R37.50/day, and 21 x R37.50 = R787.50,
-- rounded to a clean R785.
--
-- ON CONFLICT DO NOTHING for the same reason as every other row here (see
-- 065_service_packages.sql): this migration re-runs on every deploy, and an
-- upsert would silently revert an admin's own price edit on the next one.
INSERT INTO service_packages (service_key, duration_days, name, description, price, display_order) VALUES
  ('ad_banner', 21, '21-Day Advertising Banner', 'Your banner rotates in the chosen placement for 21 days.', 785.00, 3)
ON CONFLICT (service_key, duration_days) DO NOTHING;

-- The 28-day row's display_order (3, set in 065) now collides with this one.
-- Re-sequenced so the checkout list still reads 7 -> 14 -> 21 -> 28. Only
-- touches display_order (never price), and only if still at its seeded
-- value — an admin who has already reordered these is left alone.
UPDATE service_packages SET display_order = 4
  WHERE service_key = 'ad_banner' AND duration_days = 28 AND display_order = 3;
