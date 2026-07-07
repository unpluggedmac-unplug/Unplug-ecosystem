-- Unplug Ecosystem — Phase 3, Step 14: New Pricing Model
-- Depends on 001_users.sql through 009_verification_signatures.sql having already run.

-- ---------------------------------------------------------------------------
-- Articles now cost R95 to publish — same awaiting_payment pattern as
-- everything else that costs money.
-- ---------------------------------------------------------------------------
ALTER TABLE articles DROP CONSTRAINT IF EXISTS articles_status_check;
ALTER TABLE articles ADD CONSTRAINT articles_status_check
  CHECK (status IN ('awaiting_payment', 'pending', 'approved', 'rejected'));

-- ---------------------------------------------------------------------------
-- Events now cost R300 (once-off) to list on the calendar.
-- ---------------------------------------------------------------------------
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_status_check;
ALTER TABLE events ADD CONSTRAINT events_status_check
  CHECK (status IN ('awaiting_payment', 'pending', 'approved', 'rejected'));

-- Optional calendar display window, separate from the single event_date —
-- lets an event be promoted on the calendar ahead of the day itself.
ALTER TABLE events ADD COLUMN IF NOT EXISTS display_start_date DATE;

-- ---------------------------------------------------------------------------
-- Competitions now each set their OWN entry fee (The Arena = R250) rather
-- than a single global constant.
-- ---------------------------------------------------------------------------
ALTER TABLE competitions ADD COLUMN IF NOT EXISTS entry_fee NUMERIC(10,2) NOT NULL DEFAULT 50.00;

-- ---------------------------------------------------------------------------
-- Gallery submissions are now paid: R100 per bundle of up to 3 images.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gallery_bundles (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  image_count   SMALLINT NOT NULL CHECK (image_count BETWEEN 1 AND 3),
  price         NUMERIC(10,2) NOT NULL DEFAULT 100.00,
  status        VARCHAR(20) NOT NULL DEFAULT 'awaiting_payment'
                CHECK (status IN ('awaiting_payment', 'pending', 'approved', 'rejected')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE gallery_images ADD COLUMN IF NOT EXISTS bundle_id INTEGER REFERENCES gallery_bundles(id);

-- ---------------------------------------------------------------------------
-- Top 10 entries — a paid nomination for Top 10 consideration (R100),
-- distinct from the admin-curated top10_rankings table itself. Approved
-- entries are what the admin chooses from when publishing rankings.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS top10_entries (
  id            SERIAL PRIMARY KEY,
  profile_id    INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  entry_fee     NUMERIC(10,2) NOT NULL DEFAULT 100.00,
  status        VARCHAR(20) NOT NULL DEFAULT 'awaiting_payment'
                CHECK (status IN ('awaiting_payment', 'pending', 'approved', 'rejected')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (profile_id)
);

-- ---------------------------------------------------------------------------
-- Marketplace listings: flat R500 for a fixed 30-day duration (replacing
-- the old 7/14/21/28-day tiered pricing). User picks a start date; the
-- end date is computed as start + 30 days at payment confirmation.
-- ---------------------------------------------------------------------------
ALTER TABLE marketplace_listings DROP CONSTRAINT IF EXISTS marketplace_listings_duration_days_check;
ALTER TABLE marketplace_listings ADD CONSTRAINT marketplace_listings_duration_days_check
  CHECK (duration_days = 30);
ALTER TABLE marketplace_listings ALTER COLUMN duration_days SET DEFAULT 30;
ALTER TABLE marketplace_listings ADD COLUMN IF NOT EXISTS requested_start_date DATE;

-- ---------------------------------------------------------------------------
-- Bundle Vote: replace the single price-per-vote setting with fixed tiers.
-- ---------------------------------------------------------------------------
DELETE FROM settings WHERE key = 'bundle_vote_price';
CREATE TABLE IF NOT EXISTS vote_bundle_tiers (
  votes   INTEGER PRIMARY KEY,
  price   NUMERIC(10,2) NOT NULL
);
INSERT INTO vote_bundle_tiers (votes, price) VALUES
  (10, 10.00), (50, 20.00), (70, 50.00), (150, 100.00), (200, 150.00), (300, 200.00)
ON CONFLICT (votes) DO UPDATE SET price = EXCLUDED.price;

-- ---------------------------------------------------------------------------
-- Sales consultant default commission: 10% → 50%. Only affects the
-- default applied to newly-created consultants; existing ones keep
-- whatever rate they were already given.
-- ---------------------------------------------------------------------------
ALTER TABLE sales_consultants ALTER COLUMN commission_pct SET DEFAULT 50.00;

-- ---------------------------------------------------------------------------
-- Bulk email — split individuals (Directory members with type='individual')
-- from businesses (advertisers, plus Directory profiles with
-- type='business') so campaigns can target one group or the other.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bulk_email_campaigns (
  id            SERIAL PRIMARY KEY,
  sent_by       INTEGER NOT NULL REFERENCES users(id),
  segment       VARCHAR(20) NOT NULL CHECK (segment IN ('individuals', 'businesses', 'all')),
  subject       VARCHAR(255) NOT NULL,
  body          TEXT NOT NULL,
  recipient_count INTEGER NOT NULL DEFAULT 0,
  sent_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- payments.linked_type gains the three new payable items.
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_linked_type_check;
ALTER TABLE payments ADD CONSTRAINT payments_linked_type_check
  CHECK (linked_type IN ('profile_package', 'profile_upgrade', 'competition_entry', 'highlight', 'marketplace_listing', 'vote_bundle', 'article_publish', 'event_listing', 'gallery_bundle', 'top10_entry'));
