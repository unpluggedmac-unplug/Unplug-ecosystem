-- Unplug Ecosystem — Phase 3, Step 15: Editions (View Online free / Download R50)
-- Depends on 001_users.sql through 010_new_pricing_model.sql having already run.

CREATE TABLE IF NOT EXISTS editions (
  id              SERIAL PRIMARY KEY,
  issue_number    INTEGER NOT NULL UNIQUE,
  title           VARCHAR(255) NOT NULL,
  cover_image_url VARCHAR(500),
  pdf_url         VARCHAR(500) NOT NULL,
  download_price  NUMERIC(10,2) NOT NULL DEFAULT 50.00,
  published_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_editions_published ON editions (published_at DESC);

-- Records who has paid to download which edition — this is what actually
-- gates the Download button after payment. Viewing online never needs a
-- row here; it's free and open to anyone.
CREATE TABLE IF NOT EXISTS edition_purchases (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  edition_id  INTEGER NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
  payment_id  INTEGER REFERENCES payments(id),
  purchased_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, edition_id)
);

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_linked_type_check;
ALTER TABLE payments ADD CONSTRAINT payments_linked_type_check
  CHECK (linked_type IN ('profile_package', 'profile_upgrade', 'competition_entry', 'highlight', 'marketplace_listing', 'vote_bundle', 'article_publish', 'event_listing', 'gallery_bundle', 'top10_entry', 'edition_download'));
