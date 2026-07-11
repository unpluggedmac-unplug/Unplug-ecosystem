-- Unplug Ecosystem — Session F: extend the Directory taxonomy to cover
-- remaining individual professions and business-appropriate categories.
-- Same shared categories table, type = 'directory' — no schema change.
INSERT INTO categories (name, type) VALUES
  ('Speakers', 'directory'), ('Visual Artists', 'directory'),
  ('Restaurants & Cafés', 'directory'), ('Retail Stores', 'directory'),
  ('Health & Wellness Businesses', 'directory'), ('Beauty Salons & Spas', 'directory'),
  ('Property & Real Estate', 'directory'), ('Automotive Services', 'directory'),
  ('Financial & Professional Services', 'directory'), ('Trade & Construction Services', 'directory'),
  ('Event Venues & Planners', 'directory'), ('Travel & Tourism', 'directory'),
  ('Technology & Digital Services', 'directory'), ('Nonprofits & Community Organisations', 'directory'),
  ('Faith Organisations', 'directory')
ON CONFLICT (name, type) DO NOTHING;
