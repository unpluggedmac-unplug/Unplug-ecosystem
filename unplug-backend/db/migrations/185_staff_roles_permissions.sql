-- Capability-based staff access for the Unplug Control Centre.
-- Existing role='admin' remains the Super Admin role and bypasses capability checks.
-- Staff accounts use role='staff' plus one assigned staff role.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('member', 'investor', 'advertiser', 'admin', 'consultant', 'staff'));

CREATE TABLE IF NOT EXISTS staff_roles (
  id              BIGSERIAL PRIMARY KEY,
  slug            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  description     TEXT,
  is_system       BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS staff_role_permissions (
  role_id          BIGINT NOT NULL REFERENCES staff_roles(id) ON DELETE CASCADE,
  permission       TEXT NOT NULL,
  PRIMARY KEY (role_id, permission)
);

CREATE TABLE IF NOT EXISTS staff_assignments (
  user_id          INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  role_id          BIGINT NOT NULL REFERENCES staff_roles(id) ON DELETE RESTRICT,
  assigned_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  original_role    TEXT NOT NULL DEFAULT 'member',
  assigned_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS staff_assignments_role_idx ON staff_assignments(role_id);
CREATE INDEX IF NOT EXISTS staff_role_permissions_permission_idx ON staff_role_permissions(permission);

-- Built-in role templates. Super Admin is deliberately NOT a staff role:
-- role='admin' is the only unrestricted account type.
INSERT INTO staff_roles (slug, name, description, is_system) VALUES
  ('editor', 'Editor', 'Editorial content, approvals, pages and media.', true),
  ('marketing', 'Marketing', 'Advertising, campaigns, media, CRM and marketing analytics.', true),
  ('finance', 'Finance', 'Payments, orders, revenue reporting and finance analytics.', true),
  ('support', 'Support', 'Members, enquiries, CRM and submission support.', true),
  ('events-manager', 'Events Manager', 'Events, event submissions, approvals and related content.', true),
  ('competition-manager', 'Competition Manager', 'Competitions, Top 10, voting and related analytics.', true),
  ('sales', 'Sales', 'Directory, advertising, CRM, enquiries and sales reporting.', true)
ON CONFLICT (slug) DO NOTHING;

-- Seed built-in permissions only when absent. Do NOT delete/refresh them on
-- every deploy: Super Admin may deliberately customise a system role in the
-- Control Centre, and migrations must never silently undo that choice.
INSERT INTO staff_role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM staff_roles r
JOIN (VALUES
  ('editor', 'dashboard.view'), ('editor', 'content.manage'), ('editor', 'approvals.manage'),
  ('editor', 'pages.manage'), ('editor', 'media.manage'), ('editor', 'events.manage'), ('editor', 'analytics.view'),

  ('marketing', 'dashboard.view'), ('marketing', 'content.view'), ('marketing', 'media.manage'),
  ('marketing', 'advertising.manage'), ('marketing', 'marketing.manage'), ('marketing', 'crm.manage'),
  ('marketing', 'analytics.view'), ('marketing', 'reports.export'),

  ('finance', 'dashboard.view'), ('finance', 'finance.view'), ('finance', 'finance.manage'),
  ('finance', 'analytics.view'), ('finance', 'reports.export'),

  ('support', 'dashboard.view'), ('support', 'members.manage'), ('support', 'approvals.view'),
  ('support', 'crm.manage'), ('support', 'analytics.view'),

  ('events-manager', 'dashboard.view'), ('events-manager', 'events.manage'), ('events-manager', 'approvals.manage'),
  ('events-manager', 'content.view'), ('events-manager', 'media.manage'), ('events-manager', 'analytics.view'),

  ('competition-manager', 'dashboard.view'), ('competition-manager', 'competitions.manage'),
  ('competition-manager', 'content.view'), ('competition-manager', 'media.manage'), ('competition-manager', 'analytics.view'),

  ('sales', 'dashboard.view'), ('sales', 'directory.manage'), ('sales', 'advertising.manage'),
  ('sales', 'crm.manage'), ('sales', 'members.view'), ('sales', 'finance.view'),
  ('sales', 'analytics.view'), ('sales', 'reports.export')
) AS p(slug, permission) ON p.slug = r.slug
ON CONFLICT DO NOTHING;

-- The audit table originally allowed admin/member/system only.
ALTER TABLE admin_activity_log DROP CONSTRAINT IF EXISTS admin_activity_log_actor_role_check;
ALTER TABLE admin_activity_log ADD CONSTRAINT admin_activity_log_actor_role_check
  CHECK (actor_role IN ('admin', 'staff', 'member', 'system'));
