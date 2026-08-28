-- What a popup is for, in the admin's own words.
--
-- There was already a `kind` column with three values, fixed by a CHECK
-- constraint: newsletter, announcement, nominate. It decided the whole layout —
-- "newsletter" meant an email box, "nominate" meant a button pointing at
-- /nominate — so it was never really a label, it was the popup's type.
--
-- Since the builder landed, a popup is composed from blocks and the email
-- sign-up is one of them, so `kind` no longer decides anything for a composed
-- popup. It still decides everything for a popup made BEFORE the builder, which
-- is why it is left exactly as it is here rather than repurposed or dropped:
-- rewriting it would change how live popups render.
--
-- `purpose` is the new field, and it is free text on purpose. A fixed list
-- cannot anticipate what a community magazine needs to announce, and the cost
-- of the wrong list is somebody filing a popup under a heading that does not
-- describe it.
--
-- The cost of free text is that "Competition", "competition" and "Comp" become
-- three different things, which makes grouping useless. That is handled in the
-- admin screen, which suggests purposes already in use rather than leaving
-- somebody to retype a variant from memory. It is not handled by a constraint
-- here, because a constraint that rejects "Comp" would just be the fixed list
-- again wearing different clothes.
--
-- These migrations RE-RUN ON EVERY DEPLOY, so this has to be safe to run twice.
ALTER TABLE popups ADD COLUMN IF NOT EXISTS purpose VARCHAR(80);

-- The admin list groups by it, and the report compares like with like.
CREATE INDEX IF NOT EXISTS idx_popups_purpose ON popups (purpose);
