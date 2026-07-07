-- Unplug Ecosystem — Phase 3, Step 4: Articles, Events, Birthdays
-- Depends on 001_users.sql, 002_profiles.sql, 003_payments.sql having already run.

CREATE TABLE IF NOT EXISTS articles (
  id                SERIAL PRIMARY KEY,
  author_user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_id       INTEGER REFERENCES categories(id),
  title             VARCHAR(255) NOT NULL,
  body              TEXT NOT NULL,
  kicker_supplied_by VARCHAR(160),
  status            VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'rejected')),
  published_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_articles_status ON articles (status);
CREATE INDEX IF NOT EXISTS idx_articles_category ON articles (category_id);

CREATE TABLE IF NOT EXISTS events (
  id                SERIAL PRIMARY KEY,
  organizer_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name              VARCHAR(255) NOT NULL,
  event_date        DATE NOT NULL,
  venue             VARCHAR(255),
  description       TEXT,
  status            VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_events_status ON events (status);
CREATE INDEX IF NOT EXISTS idx_events_date ON events (event_date);

CREATE TABLE IF NOT EXISTS birthdays (
  id            SERIAL PRIMARY KEY,
  profile_id    INTEGER REFERENCES profiles(id) ON DELETE SET NULL,
  name          VARCHAR(160) NOT NULL,
  birth_month   SMALLINT NOT NULL CHECK (birth_month BETWEEN 1 AND 12),
  birth_day     SMALLINT NOT NULL CHECK (birth_day BETWEEN 1 AND 31),
  recurring     BOOLEAN NOT NULL DEFAULT true,
  photo_url     VARCHAR(500),
  message       VARCHAR(500),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_birthdays_month_day ON birthdays (birth_month, birth_day);

-- Note: birthdays are admin-only, once-off entries per the locked Blueprint
-- (Section 9) — there is deliberately no public submission route for them,
-- unlike articles/events/gallery which members can submit themselves.
