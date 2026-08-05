-- Participation Engine — Stage A: foundation schema.
-- Ported from a Supabase-native spec onto this project's actual stack:
-- integer SERIAL ids referencing the existing `users` table (not UUIDs
-- against auth.users), no RLS (access control stays in Express
-- requireAuth/requireAdmin middleware, same as every other route in this
-- codebase). Nothing here is read or written yet — pure schema, so this
-- migration is zero-risk to deploy on its own.

-- =============================================================
-- 1. ACTION CATEGORIES + PARTICIPATION ACTIONS (the rule engine)
-- Every scorable action is a row here, admin-editable, so new ways to
-- earn points never require a deploy.
-- =============================================================
CREATE TABLE IF NOT EXISTS action_categories (
  id          SERIAL PRIMARY KEY,
  code        VARCHAR(30) NOT NULL UNIQUE,
  label       VARCHAR(80) NOT NULL,
  description TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS participation_actions (
  id                      SERIAL PRIMARY KEY,
  code                    VARCHAR(60) NOT NULL UNIQUE,
  label                   VARCHAR(120) NOT NULL,
  category_code           VARCHAR(30) NOT NULL REFERENCES action_categories(code),
  content_type            VARCHAR(30),

  base_points             INTEGER NOT NULL DEFAULT 0,
  quality_multiplier_max  NUMERIC(4,2) NOT NULL DEFAULT 1.0,
  impact_eligible         BOOLEAN NOT NULL DEFAULT FALSE,

  daily_limit             INTEGER,
  weekly_limit            INTEGER,
  monthly_limit           INTEGER,
  cooldown_minutes        INTEGER,

  requires_approval       BOOLEAN NOT NULL DEFAULT FALSE,
  min_trust_score         NUMERIC(5,2) NOT NULL DEFAULT 0,
  min_status_rank         INTEGER NOT NULL DEFAULT 0,

  counts_for_active_month BOOLEAN NOT NULL DEFAULT FALSE,
  counts_as_meaningful    BOOLEAN NOT NULL DEFAULT FALSE,
  counts_as_contribution  BOOLEAN NOT NULL DEFAULT FALSE,
  counts_for_streak       BOOLEAN NOT NULL DEFAULT FALSE,

  unique_per_object       BOOLEAN NOT NULL DEFAULT TRUE,
  fraud_weight            NUMERIC(3,2) NOT NULL DEFAULT 1.0,

  is_enabled              BOOLEAN NOT NULL DEFAULT TRUE,
  notes                   TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pactions_category ON participation_actions(category_code);
CREATE INDEX IF NOT EXISTS idx_pactions_enabled ON participation_actions(is_enabled);

-- =============================================================
-- 2. POINT LEDGER
-- Immutable transaction log. Never updated in place — only appended to,
-- with reversal fields for admin-initiated corrections.
-- =============================================================
CREATE TABLE IF NOT EXISTS participation_points (
  id                SERIAL PRIMARY KEY,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action_code       VARCHAR(60) NOT NULL REFERENCES participation_actions(code),

  content_type      VARCHAR(30),
  content_id        INTEGER,
  content_owner_id  INTEGER REFERENCES users(id),

  base_points       INTEGER NOT NULL DEFAULT 0,
  quality_bonus     INTEGER NOT NULL DEFAULT 0,
  impact_bonus      INTEGER NOT NULL DEFAULT 0,
  consistency_bonus INTEGER NOT NULL DEFAULT 0,
  total_points      INTEGER NOT NULL DEFAULT 0,

  source            VARCHAR(20) NOT NULL DEFAULT 'system',
  granted_by        INTEGER REFERENCES users(id),
  notes             TEXT,

  is_reversed       BOOLEAN NOT NULL DEFAULT FALSE,
  reversed_at       TIMESTAMPTZ,
  reversed_by       INTEGER REFERENCES users(id),
  reversal_reason   TEXT,

  earned_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_points_user ON participation_points(user_id, is_reversed, earned_at DESC);
CREATE INDEX IF NOT EXISTS idx_points_action ON participation_points(action_code);
CREATE INDEX IF NOT EXISTS idx_points_content ON participation_points(content_type, content_id);
CREATE INDEX IF NOT EXISTS idx_points_content_owner ON participation_points(content_owner_id);

-- =============================================================
-- 3. RATE-LIMIT TRACKERS
-- Fast lookups so award_points() never has to scan the full ledger to
-- enforce daily/weekly/monthly/per-object limits.
-- =============================================================
CREATE TABLE IF NOT EXISTS daily_action_tracker (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action_code     VARCHAR(60) NOT NULL REFERENCES participation_actions(code),
  action_date     DATE NOT NULL DEFAULT CURRENT_DATE,
  count           INTEGER NOT NULL DEFAULT 1,
  last_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, action_code, action_date)
);
CREATE INDEX IF NOT EXISTS idx_daily_tracker_user ON daily_action_tracker(user_id, action_date);

CREATE TABLE IF NOT EXISTS weekly_action_tracker (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action_code     VARCHAR(60) NOT NULL REFERENCES participation_actions(code),
  iso_year        INTEGER NOT NULL,
  iso_week        INTEGER NOT NULL,
  count           INTEGER NOT NULL DEFAULT 1,
  last_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, action_code, iso_year, iso_week)
);

CREATE TABLE IF NOT EXISTS monthly_action_tracker (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action_code     VARCHAR(60) NOT NULL REFERENCES participation_actions(code),
  year            INTEGER NOT NULL,
  month           INTEGER NOT NULL,
  count           INTEGER NOT NULL DEFAULT 1,
  last_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, action_code, year, month)
);

-- Prevents double-earning the same action on the same content item.
CREATE TABLE IF NOT EXISTS object_action_tracker (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action_code     VARCHAR(60) NOT NULL REFERENCES participation_actions(code),
  content_type    VARCHAR(30) NOT NULL,
  content_id      INTEGER NOT NULL,
  earned_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_reversed     BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (user_id, action_code, content_type, content_id)
);
CREATE INDEX IF NOT EXISTS idx_object_tracker_user ON object_action_tracker(user_id, action_code);

-- =============================================================
-- 4. ACTIVE MONTHS
-- A calendar month only counts toward status progression if it was
-- genuinely earned (enough active days + meaningful actions), not just
-- aged through.
-- =============================================================
CREATE TABLE IF NOT EXISTS active_months (
  id                        SERIAL PRIMARY KEY,
  user_id                   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  year                      INTEGER NOT NULL,
  month                     INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  active_days               INTEGER NOT NULL DEFAULT 0,
  meaningful_actions        INTEGER NOT NULL DEFAULT 0,
  qualifying_contributions  INTEGER NOT NULL DEFAULT 0,
  is_qualified              BOOLEAN NOT NULL DEFAULT FALSE,
  qualified_at              TIMESTAMPTZ,
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, year, month)
);
CREATE INDEX IF NOT EXISTS idx_active_months_qualified ON active_months(user_id, is_qualified);

-- =============================================================
-- 5. MEMBER STATUS LEVELS + HISTORY
-- The gamified status ladder (Explorer -> ... -> member_hall_of_fame).
-- Named distinctly from the existing `hall_of_fame` table (past
-- competition winners, admin-entered) — this is a different concept:
-- an auto-computed member tier based on points/tenure/activity.
-- =============================================================
CREATE TABLE IF NOT EXISTS member_status_levels (
  id                        SERIAL PRIMARY KEY,
  code                      VARCHAR(30) NOT NULL UNIQUE,
  label                     VARCHAR(60) NOT NULL,
  emoji                     VARCHAR(10) NOT NULL,
  rank_order                INTEGER NOT NULL,
  min_score                 INTEGER NOT NULL DEFAULT 0,
  min_days_since_join       INTEGER NOT NULL DEFAULT 0,
  min_active_months         INTEGER NOT NULL DEFAULT 0,
  requires_admin_approval   BOOLEAN NOT NULL DEFAULT FALSE,
  is_member_hall_of_fame    BOOLEAN NOT NULL DEFAULT FALSE,
  description               TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS member_status_history (
  id                        SERIAL PRIMARY KEY,
  user_id                   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status_code               VARCHAR(30) NOT NULL REFERENCES member_status_levels(code),
  previous_status           VARCHAR(30) REFERENCES member_status_levels(code),
  achieved_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  score_at_time             INTEGER NOT NULL DEFAULT 0,
  active_months_at_time     INTEGER NOT NULL DEFAULT 0,
  days_since_join_at_time   INTEGER NOT NULL DEFAULT 0,
  granted_by                INTEGER REFERENCES users(id),
  notes                     TEXT,
  is_active_status          BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS idx_member_status_history_user ON member_status_history(user_id);
CREATE INDEX IF NOT EXISTS idx_member_status_history_current ON member_status_history(user_id, is_active_status);

-- =============================================================
-- 6. SCORE + MOMENTUM + TRUST CACHES
-- Materialised for fast reads. The ledger (participation_points) is
-- always the source of truth — these are rebuilt from it, never edited
-- directly.
-- =============================================================
CREATE TABLE IF NOT EXISTS score_cache (
  user_id                 INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  unplug_score            INTEGER NOT NULL DEFAULT 0,
  participation_score     INTEGER NOT NULL DEFAULT 0,
  contribution_score      INTEGER NOT NULL DEFAULT 0,
  impact_score            INTEGER NOT NULL DEFAULT 0,
  recognition_score       INTEGER NOT NULL DEFAULT 0,
  quality_score           INTEGER NOT NULL DEFAULT 0,
  consistency_score       INTEGER NOT NULL DEFAULT 0,
  momentum_score          INTEGER NOT NULL DEFAULT 0,
  total_actions           INTEGER NOT NULL DEFAULT 0,
  qualified_active_months INTEGER NOT NULL DEFAULT 0,
  days_since_join         INTEGER NOT NULL DEFAULT 0,
  current_streak_days     INTEGER NOT NULL DEFAULT 0,
  longest_streak_days     INTEGER NOT NULL DEFAULT 0,
  last_recalculated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS momentum_scores (
  user_id             INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  momentum_7d         INTEGER NOT NULL DEFAULT 0,
  momentum_30d        INTEGER NOT NULL DEFAULT 0,
  momentum_index      INTEGER NOT NULL DEFAULT 0,
  calculated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trust_scores (
  user_id             INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  score               NUMERIC(5,2) NOT NULL DEFAULT 100.00 CHECK (score BETWEEN 0 AND 100),
  flags               INTEGER NOT NULL DEFAULT 0,
  warnings            INTEGER NOT NULL DEFAULT 0,
  last_flag_at        TIMESTAMPTZ,
  notes               TEXT,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_streaks (
  user_id             INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  current_streak_days INTEGER NOT NULL DEFAULT 0,
  longest_streak_days INTEGER NOT NULL DEFAULT 0,
  streak_started_at   DATE,
  last_streak_action  DATE,
  streak_broken_at    DATE,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================
-- 7. MODERATION LOG + NOTIFICATIONS
-- Core infrastructure the scoring functions rely on (status-change
-- notices, admin point reversals) — included here rather than a later
-- stage so nothing in Stage A references a table that doesn't exist yet.
-- =============================================================
CREATE TABLE IF NOT EXISTS moderation_actions (
  id                    SERIAL PRIMARY KEY,
  target_user_id        INTEGER NOT NULL REFERENCES users(id),
  admin_user_id         INTEGER REFERENCES users(id),
  action_type           VARCHAR(40) NOT NULL,
  reason                TEXT NOT NULL,
  related_content_type  VARCHAR(30),
  related_content_id    INTEGER,
  points_affected        INTEGER DEFAULT 0,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_moderation_target ON moderation_actions(target_user_id);

CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id               INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  web_enabled           BOOLEAN NOT NULL DEFAULT TRUE,
  email_enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  notify_status_change  BOOLEAN NOT NULL DEFAULT TRUE,
  notify_achievement    BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notifications (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type            VARCHAR(30) NOT NULL,
  title           VARCHAR(200) NOT NULL,
  body            TEXT NOT NULL,
  link_url        VARCHAR(300),
  is_read         BOOLEAN NOT NULL DEFAULT FALSE,
  read_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read, created_at DESC);

-- =============================================================
-- 8. updated_at trigger helper — shared by the status/action tables above.
-- =============================================================
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_pactions_updated_at ON participation_actions;
CREATE TRIGGER trg_pactions_updated_at BEFORE UPDATE ON participation_actions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_member_status_levels_updated_at ON member_status_levels;
CREATE TRIGGER trg_member_status_levels_updated_at BEFORE UPDATE ON member_status_levels FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================
-- 9. SEED — status ladder + starter action categories.
-- Idempotent via ON CONFLICT DO NOTHING, matching every other seed in
-- this codebase; admin can edit all of this after the fact.
-- =============================================================
INSERT INTO member_status_levels (code, label, emoji, rank_order, min_score, min_days_since_join, min_active_months, requires_admin_approval, is_member_hall_of_fame, description)
VALUES
  ('explorer',          'Explorer',          '🌱', 1,     0,   0,  0, FALSE, FALSE, 'You have joined the Unplug community.'),
  ('trailblazer',       'Trailblazer',       '🚀', 2,   500,  30,  1, FALSE, FALSE, 'You are no longer just visiting — you are participating.'),
  ('rising_icon',       'Rising Icon',       '💎', 3,  1500,  90,  3, FALSE, FALSE, 'People are beginning to notice you.'),
  ('legend',            'Legend',            '👑', 4,  4000, 180,  6, FALSE, FALSE, 'You have established a meaningful presence on Unplug.'),
  ('global_influencer', 'Global Influencer', '🌍', 5, 10000, 365, 12, FALSE, FALSE, 'Your participation has influence beyond yourself.'),
  ('member_hall_of_fame','Hall of Fame',     '⭐', 6, 10000, 730, 18, TRUE,  TRUE,  'The highest member honour on Unplug.')
ON CONFLICT (code) DO NOTHING;

INSERT INTO action_categories (code, label, description, sort_order)
VALUES
  ('consumption',  'Consumption',  'Viewing, reading and basic interactions', 1),
  ('contribution', 'Contribution', 'Creating, submitting and adding original value', 2),
  ('social',       'Social',       'Liking, sharing, commenting and engaging', 3),
  ('competitive',  'Competitive',  'Entering, voting and competing', 4),
  ('community',    'Community',    'Recognising, nominating, referring and building', 5),
  ('achievement',  'Achievement',  'Achievement and milestone rewards', 6)
ON CONFLICT (code) DO NOTHING;
