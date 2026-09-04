-- ARENA-001: a competition's public page had no way to say what the prize
-- is, what the rules or eligibility criteria are, or how a winner gets
-- picked — none of that exists anywhere in this system yet, and it is real
-- editorial content only the publisher can supply, not something to invent.
--
-- All four nullable, all default NULL: a competition with none of this
-- filled in shows none of it, rather than a page full of placeholder text.
-- Same "real content or hide it" rule the site already applies to audience
-- statistics elsewhere.

ALTER TABLE competitions ADD COLUMN IF NOT EXISTS prize TEXT;
ALTER TABLE competitions ADD COLUMN IF NOT EXISTS rules TEXT;
ALTER TABLE competitions ADD COLUMN IF NOT EXISTS eligibility TEXT;
ALTER TABLE competitions ADD COLUMN IF NOT EXISTS winner_process TEXT;
