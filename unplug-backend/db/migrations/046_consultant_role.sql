-- Sales consultants publish without paying.
--
-- Modelled as a role rather than checking the email domain at request time.
-- A domain check would mean anyone who ever signed up with an unplugnews.com
-- address keeps free publishing forever, including someone who has left —
-- and revoking it would require changing their email. A role can be granted
-- and withdrawn.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('member', 'investor', 'advertiser', 'admin', 'consultant'));

-- Links a consultant record to the account they sign in with, so their
-- referrals and activity can be attributed.
ALTER TABLE sales_consultants ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS sales_consultants_user_idx ON sales_consultants (user_id);

-- Promote any existing account on the company domain, and attach it to its
-- consultant record where the addresses match. Admins are left alone: an
-- admin already publishes free and demoting one would remove access.
UPDATE users
   SET role = 'consultant'
 WHERE lower(email) LIKE '%@unplugnews.com'
   AND role = 'member';

UPDATE sales_consultants c
   SET user_id = u.id
  FROM users u
 WHERE c.user_id IS NULL
   AND lower(c.email) = lower(u.email);
