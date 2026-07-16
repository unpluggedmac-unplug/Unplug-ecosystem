-- Homepage "The Guy Says" shoutout — was a single hardcoded name in the
-- HTML. This makes it a daily-rotating feature: the public can nominate a
-- name+surname, an admin approves nominations, and one shoutout is shown
-- per calendar day. When there are no approved nominations left to show, a
-- seeded South African name is used as the fallback so the section is
-- never empty (the idea is that visitors come back daily to see the next
-- shoutout).

-- Public nominations. Nothing is shown publicly until an admin approves it,
-- so this can safely be an unauthenticated submission.
CREATE TABLE IF NOT EXISTS shoutout_nominations (
  id                 SERIAL PRIMARY KEY,
  nominee_name       VARCHAR(200) NOT NULL,   -- full "Name Surname"
  message            TEXT,                    -- optional reason / note
  submitted_by_email VARCHAR(255),            -- optional, for our reference only
  status             VARCHAR(20) NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shoutout_nominations_status ON shoutout_nominations (status, created_at);

-- Seeded South African names used as the automatic fallback when there are
-- no approved nominations to show for a given day.
CREATE TABLE IF NOT EXISTS shoutout_fallbacks (
  id   SERIAL PRIMARY KEY,
  name VARCHAR(200) NOT NULL UNIQUE
);
INSERT INTO shoutout_fallbacks (name) VALUES
  ('Naledi Mokoena'),
  ('Sipho Radebe'),
  ('Amahle Zulu'),
  ('Thabo Nkosi'),
  ('Lerato Dlamini'),
  ('Sizwe Khumalo'),
  ('Zanele Mthembu'),
  ('Kagiso Molefe'),
  ('Nomvula Sithole'),
  ('Tebogo Mahlangu'),
  ('Palesa Mokoena'),
  ('Bongani Ngcobo'),
  ('Refilwe Motaung'),
  ('Andile Zwane'),
  ('Precious Baloyi')
ON CONFLICT (name) DO NOTHING;

-- One materialized shoutout per day. The first visitor of the day fills in
-- the row (idempotently, via ON CONFLICT), and everyone else that day reads
-- it — so the shoutout is stable within a day and rotates to a new one the
-- next day. Exactly one of nomination_id / fallback_name is set.
CREATE TABLE IF NOT EXISTS shoutout_schedule (
  shoutout_date DATE PRIMARY KEY,
  nomination_id INTEGER REFERENCES shoutout_nominations(id) ON DELETE SET NULL,
  fallback_name VARCHAR(200),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
