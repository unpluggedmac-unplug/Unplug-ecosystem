-- TRUST-003: real testimonials from real directory members, advertisers and
-- featured people — the punch-list is explicit that a fabricated quote is
-- worse than none at all. This table is the mechanism only; gathering the
-- actual quotes is a manual task for the publisher, same as the Arena's
-- prize/rules (migration 172) and every other "real content, not invented"
-- gap this cycle.
--
-- ACTIVE DEFAULTS TO FALSE, same reasoning as Popups and Site Buttons: a
-- testimonial half-entered on a Tuesday must not be live on the site
-- overnight.

CREATE TABLE IF NOT EXISTS testimonials (
  id              SERIAL PRIMARY KEY,
  quote           TEXT NOT NULL,
  author_name     VARCHAR(160) NOT NULL,
  -- Free text, not an enum — "Directory member (Pro)", "Advertiser since
  -- 2026", "Featured in Issue 3" are all real answers the admin might want,
  -- and a fixed list of categories would just get typed around anyway.
  author_role     VARCHAR(160),
  author_photo_url TEXT,
  display_order   INTEGER NOT NULL DEFAULT 0,
  active          BOOLEAN NOT NULL DEFAULT false,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The public endpoint's only query: what is switched on, in display order.
CREATE INDEX IF NOT EXISTS idx_testimonials_active ON testimonials (active, display_order, id);
