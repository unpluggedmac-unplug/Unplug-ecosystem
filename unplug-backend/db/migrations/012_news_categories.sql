-- Unplug Ecosystem — News categories.
-- The 'news' category type existed in the categories table (002_profiles.sql)
-- but was never seeded, unlike the 27 Directory categories seeded alongside
-- it — the Latest News page's category filter had nothing real to match
-- against. Seeding the list confirmed in the site's own category filter.

INSERT INTO categories (name, type) VALUES
  ('Entrepreneurship & Business', 'news'), ('Career Success', 'news'),
  ('Personal Growth', 'news'), ('Leadership', 'news'),
  ('Innovation & Technology', 'news'), ('Lifestyle & Luxury', 'news'),
  ('Health & Wellness', 'news'), ('Fashion & Style', 'news'),
  ('Travel & Experiences', 'news'), ('Finance & Wealth', 'news'),
  ('Community Impact', 'news'), ('Arts & Creativity', 'news'),
  ('Food & Hospitality', 'news'), ('Relationships & Family', 'news'),
  ('Property & Real Estate', 'news'), ('Motoring', 'news'),
  ('Entertainment & Culture', 'news'), ('Events & Awards', 'news'),
  ('Education & Skills', 'news'), ('Faith & Inspiration', 'news'),
  ('Other', 'news')
ON CONFLICT (name, type) DO NOTHING;
