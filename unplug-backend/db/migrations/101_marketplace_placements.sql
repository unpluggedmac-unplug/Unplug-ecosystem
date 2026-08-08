-- The Marketplace "Advertise With Us" cards, made admin-editable with real
-- images instead of the grey size placeholders hardcoded in
-- unplug-magazine.html.
--
-- Seeded with exactly the seven cards the page already showed, wording and
-- order included, so the page looks identical the moment this runs and only
-- changes when an admin edits something — the same "seed, don't surprise"
-- approach page_content took.
--
-- Deliberately its own table rather than more page_blocks rows: these are a
-- rate card with a fixed shape (spec line, blurb, enquiry button) rendered in
-- their own grid, whereas page_blocks are free-form content an admin drops
-- onto any page. Folding them together would mean one of the two grows
-- columns it never uses.

CREATE TABLE IF NOT EXISTS marketplace_placements (
  id           SERIAL PRIMARY KEY,
  slug         VARCHAR(60) NOT NULL UNIQUE,
  title        VARCHAR(160) NOT NULL,
  -- The size/format line shown over the image, e.g. "1240x200". Optional:
  -- a placement sold as an idea rather than a spec does not need one.
  spec_label   VARCHAR(80),
  description  TEXT,
  image_url    TEXT,
  button_label VARCHAR(60) NOT NULL DEFAULT 'Get In Contact',
  -- Where the button goes. An internal page id ("contact") keeps the current
  -- behaviour; a full URL is also allowed for an external enquiry form.
  button_target VARCHAR(255) NOT NULL DEFAULT 'contact',
  -- The premium card was visually distinct on the page (red border, dark
  -- preview). Kept as a flag so that styling survives becoming data, rather
  -- than being flattened into "just another card".
  is_featured  BOOLEAN NOT NULL DEFAULT false,
  position     INTEGER NOT NULL DEFAULT 0,
  is_visible   BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS marketplace_placements_public_idx
  ON marketplace_placements (is_visible, position);

-- ON CONFLICT DO NOTHING so re-running never overwrites an admin's edits.
INSERT INTO marketplace_placements (slug, title, spec_label, description, is_featured, position) VALUES
  ('homepage-hero',       'Homepage Hero Banner',        '1240x200',          'Maximum visibility at the top of the homepage, seen by every visitor.',                                                                                                     false, 1),
  ('top10-sponsor',       'Top 10 Presenting Sponsor',   'Full-width',        'Your brand credited as the sponsor of our most-read quarterly feature.',                                                                                                    false, 2),
  ('directory-sponsor',   'Directory Sidebar Placement', '300x250',           'Reach an audience of professionals and changemakers browsing our directory.',                                                                                               false, 3),
  ('sponsored-editorial', 'Sponsored Editorial',         'Editorial Feature', 'Full story feature written and published by our editorial team with your brand woven in.',                                                                                  false, 4),
  ('newsletter-banner',   'Newsletter Placement',        '600x120',           'In-email banner reaching our weekly subscriber base directly in their inbox.',                                                                                              false, 5),
  ('competition-sponsor', 'Competition Sponsorship',     'Full Brand Wrap',   'Name your brand on our quarterly competition — logo on banners, emails, and awards night.',                                                                                 false, 6),
  ('business-placement',  'Business Placement',          'Premium Package',   'Comprehensive brand integration across the entire Unplug platform — editorial, directory, social, events, and competitions. Maximum visibility for businesses serious about community impact.', true, 7)
ON CONFLICT (slug) DO NOTHING;
