-- Business Premium profiles get a second, optional category so they can
-- appear under two listings (e.g. "Restaurants & Cafés" AND "Event Venues").
-- NULL for every other tier/type.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS secondary_category_id INTEGER REFERENCES categories(id);
