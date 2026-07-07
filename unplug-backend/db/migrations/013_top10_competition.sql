-- Unplug Ecosystem — real "Top 10" competition.
-- The static reference site's Top 10 page is built around live public
-- voting that directly determines rank. The backend's actual top10_rankings
-- table is admin-curated (published manually, no live voting at all) —
-- live voting only exists via the competitions system. Per product decision
-- 2026-07-07: the public Top 10 page is wired to a real competition (this
-- one) rather than the admin-curated table, so voting is genuinely live.

INSERT INTO competitions (name, slug, description, opens_at, closes_at, status, entry_fee)
VALUES (
  'Top 10 Impact List',
  'top-10',
  'Unplug''s flagship community leaderboard — ranked live by reader votes.',
  now(),
  now() + interval '365 days',
  'open',
  100.00
)
ON CONFLICT (slug) DO NOTHING;
