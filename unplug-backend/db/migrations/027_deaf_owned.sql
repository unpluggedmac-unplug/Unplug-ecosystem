-- Deaf-Owned Verified badge for Directory listings. An admin marks a
-- business/profile as deaf-owned; the 🤟 badge then shows on its card and
-- detail page.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS deaf_owned_verified BOOLEAN NOT NULL DEFAULT false;
