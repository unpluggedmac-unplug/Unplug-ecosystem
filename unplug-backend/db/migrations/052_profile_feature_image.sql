-- A feature image for Directory profiles.
--
-- Profiles had no main photo of their own — the directory card and the profile
-- page both showed an empty placeholder, and the only images were gallery
-- shots. feature_image_url is the one banner/headshot that represents the
-- profile: it fills the card thumbnail and the profile hero. Nullable, so every
-- existing profile keeps working and simply shows the placeholder until an
-- image is set.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS feature_image_url TEXT;
