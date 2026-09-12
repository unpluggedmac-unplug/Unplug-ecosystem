-- 197: Coming Soon mode — a site-wide "please check back later" message an
-- admin can switch on without a deploy.
--
-- Same shape as unlisted_pages (146): settings the public magazine reads on
-- every page load, toggled through the admin's existing generic
-- GET/PATCH /admin/settings endpoints rather than a dedicated pair of routes.
-- settings.value is already TEXT (migration 146), so no column change needed.
--
-- NOT A SECURITY CONTROL — same caveat as <unplug-coming-soon> in
-- unplug-components.js. It hides the page in the browser; the content is
-- still in the HTML and still reachable through the API. A signed-in admin
-- (unplug_admin_token present) always sees the real site, so the change
-- behind it can be checked before switching this back off for everyone else.
--
-- OFF BY DEFAULT. ON CONFLICT DO NOTHING so a re-run (every migration here
-- runs again on every deploy) never flips a live site into Coming Soon mode,
-- and never resets an admin's chosen heading/message back to the default.
INSERT INTO settings (key, value) VALUES ('coming_soon_active', 'false')
  ON CONFLICT (key) DO NOTHING;
INSERT INTO settings (key, value) VALUES ('coming_soon_heading', 'We''ll be back shortly')
  ON CONFLICT (key) DO NOTHING;
INSERT INTO settings (key, value) VALUES ('coming_soon_message', 'We''re currently working on the site. Please check back later.')
  ON CONFLICT (key) DO NOTHING;
