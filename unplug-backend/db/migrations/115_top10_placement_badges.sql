-- The three Top 10 placement badges.
--
-- Awarded automatically when the Top 10 is published at the end of each
-- month, stamped with that month and year — so a member who wins in August
-- and again in October holds two separate badges rather than one that
-- silently overwrites the first. That is what the award_month/award_year
-- columns from 099 are for.
--
-- No award_month/award_year is set on the BADGE rows themselves. These are
-- recurring, not one-off: the period belongs to each award, not to the badge
-- definition. Setting it here would pin every future winner to one month.

INSERT INTO badges (code, label, description, emoji, category, sort_order) VALUES
  ('top10_champion',
   'Top 10 Champion',
   'Finished first on the Unplug Top 10 for the month.',
   '🥇', 'Top 10', 1),
  ('top10_runner_up',
   'Top 10 Runner-Up',
   'Finished second on the Unplug Top 10 for the month.',
   '🥈', 'Top 10', 2),
  ('top10_third_place',
   'Top 10 Third Place',
   'Finished third on the Unplug Top 10 for the month.',
   '🥉', 'Top 10', 3)
ON CONFLICT (code) DO NOTHING;
