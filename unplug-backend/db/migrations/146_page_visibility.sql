-- Unlisted pages: in the site but not in the menus.
--
-- WordPress calls this "unlisted" and the name is the specification: the page
-- works, the link can be sent to anybody, and it simply does not appear in the
-- navigation. It is for a page you hand out — a campaign landing page, a
-- nomination form in a social bio — rather than one you want people to browse
-- into.
--
-- WHAT IT IS NOT: it is not privacy. An unlisted page is fully public to
-- anybody holding the address, it stays in the sitemap, and search engines are
-- still told about it. Nothing here should ever be used to hide something that
-- actually needs protecting — that is what an account and a role are for.
--
-- STORED AS ONE SETTING rather than a column on a pages table, because there
-- is no pages table: the magazine is a single document whose "pages" are
-- <main id="page-*"> elements. A list of ids in the settings table is the
-- honest shape for that, and it reuses the admin's existing generic
-- GET/PATCH /admin/settings endpoints rather than inventing a parallel pair.

-- settings.value was VARCHAR(255), which is fine for a price and not fine for
-- a list. Twenty page ids would fit; twenty-five would be SILENTLY TRUNCATED
-- at the column, and the symptom would be an admin unlisting a page and it
-- staying in the menu with no error anywhere.
--
-- varchar -> text is binary-coercible, so Postgres does this without rewriting
-- the table, and re-running it when the column is already text is a no-op —
-- which matters, because every migration here runs again on every deploy.
ALTER TABLE settings ALTER COLUMN value TYPE TEXT;

-- Empty: every page listed. Seeded so the admin's PATCH /admin/settings/:key
-- has a row to update — it updates rather than upserts, and would 404 on a
-- key that has never existed.
--
-- ON CONFLICT DO NOTHING so a re-run never resets a choice an admin has made.
-- Seeding a real default on every deploy is how somebody's settings quietly
-- revert on a Tuesday.
INSERT INTO settings (key, value) VALUES ('unlisted_pages', '')
  ON CONFLICT (key) DO NOTHING;
