-- Optional Directory location, for the existing Map View / Near Me features.
--
-- Reuses the location columns added in 039 (city, province, latitude,
-- longitude) — this only adds the parts that were missing: a street address
-- (businesses only, by policy), a suburb, and a country. All nullable with no
-- default, so this is a metadata-only change that cannot fail on existing rows
-- and every existing Directory profile keeps working untouched.
--
-- Privacy: street_address is only ever collected/shown for type='business'.
-- Individuals give suburb/town/province/country only, so the map places them at
-- area level and never publishes a residential street address.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS street_address VARCHAR(200);
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS suburb         VARCHAR(120);
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS country        VARCHAR(80);
