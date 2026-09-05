-- Let an admin create a Directory listing directly, for a sponsor/business/
-- person who has no member account and may never have one — e.g. a business
-- captured at an event, or a partner the site wants listed before they sign
-- up. Requested directly: "allow admin to add directory profiles manually."
--
-- profiles.user_id was NOT NULL with a plain unique index — every listing had
-- to belong to exactly one member, by design (see adminProfileLinks.js's
-- comments, written when that was still true). An admin-created listing has
-- no member behind it yet, so the column must accept NULL. The unique index
-- becomes partial so it still enforces "one listing per member" for every
-- listing that DOES have an owner, while allowing any number of ownerless
-- ones to coexist.
--
-- A listing created this way can still be linked to a member afterwards —
-- the existing "Link a listing to a member account" panel (admin dashboard,
-- Directory Profiles) and POST /admin/links/directory/:id already handle
-- that; this migration is what makes it legal for the listing to start out
-- with no owner at all.
ALTER TABLE profiles ALTER COLUMN user_id DROP NOT NULL;

DROP INDEX IF EXISTS idx_profiles_user_id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_user_id ON profiles (user_id) WHERE user_id IS NOT NULL;
