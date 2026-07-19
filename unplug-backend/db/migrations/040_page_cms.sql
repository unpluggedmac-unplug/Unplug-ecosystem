-- Editable page content. The existing `settings` table caps values at 255
-- characters and only supports updates to pre-seeded keys, which is fine for
-- a price but useless for page copy — hence separate tables here.

-- Free-text overrides for individual pieces of page copy. The frontend tags
-- an element with data-cms="home.hero.title"; if a row exists for that key
-- its value replaces the built-in wording, otherwise the page keeps whatever
-- is hardcoded. That means an empty table changes nothing.
CREATE TABLE IF NOT EXISTS page_content (
  page_key    VARCHAR(60)  NOT NULL,
  content_key VARCHAR(120) NOT NULL,
  value       TEXT         NOT NULL,
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (page_key, content_key)
);

CREATE INDEX IF NOT EXISTS page_content_page_idx ON page_content (page_key);

-- Image blocks an admin can add to any page: image plus title, subheading,
-- description and an optional button. Every field is optional so a block can
-- be a plain banner, a text callout, or a full promo card.
CREATE TABLE IF NOT EXISTS page_blocks (
  id           SERIAL PRIMARY KEY,
  page_key     VARCHAR(60) NOT NULL,
  title        VARCHAR(255),
  subheading   VARCHAR(255),
  description  TEXT,
  image_url    TEXT,
  button_label VARCHAR(120),
  button_url   TEXT,
  position     INTEGER NOT NULL DEFAULT 0,
  is_visible   BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Public reads are always "visible blocks for this page, in order".
CREATE INDEX IF NOT EXISTS page_blocks_public_idx
  ON page_blocks (page_key, is_visible, position);
