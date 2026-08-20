-- Directory highlight packages are called "Homepage Highlight", not "Profile
-- Highlight".
--
-- Background: GET /highlights/packages used to serve a hardcoded list that
-- called these "N-Day Homepage Highlight". When that list was changed to read
-- service_packages (so the buy form and the checkout charge could no longer
-- disagree on price), the names came with it — and the names seeded in
-- migration 065 said "Profile Highlight". The wording on the member's dropdown
-- changed as a side effect of a pricing fix. This puts it back.
--
-- WHY THE WHERE CLAUSE MATTERS. db/migrate.js re-runs every migration on every
-- deploy, and these names are admin-editable. A bare UPDATE would re-apply
-- itself on every deploy and silently undo any later rename an admin made —
-- the same trap migration 065's ON CONFLICT DO NOTHING avoids for prices.
--
-- So this only touches rows still carrying the exact wording it is correcting.
-- After the first run nothing matches, and if an admin renames these later
-- nothing matches either. The migration disarms itself.
UPDATE service_packages
   SET name = replace(name, 'Profile Highlight', 'Homepage Highlight'),
       updated_at = now()
 WHERE service_key = 'highlight_directory'
   AND name LIKE '%-Day Profile Highlight';

-- The description said "on the homepage" already, so it needed no change.
