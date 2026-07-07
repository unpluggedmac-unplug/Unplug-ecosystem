-- Unplug Ecosystem — "The Arena" competition, referenced throughout the
-- codebase as the flagship example (R250 entry fee — see comments in
-- src/routes/competitions.js and payments.js) but never actually seeded.
-- Real dates are placeholders (a year-long open window) since the actual
-- open/close schedule is an editorial decision, not something to invent —
-- update opens_at/closes_at once Pierre/Darius confirm the real dates.

INSERT INTO competitions (name, slug, description, opens_at, closes_at, status, entry_fee)
VALUES (
  'The Arena',
  'the-arena',
  'Nominate someone unplugging good into the world.',
  now(),
  now() + interval '365 days',
  'open',
  250.00
)
ON CONFLICT (slug) DO NOTHING;
