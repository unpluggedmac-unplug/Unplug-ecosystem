-- The consultant role is normally restricted to @unplugnews.com addresses
-- (046_consultant_role.sql) — a real security rule, not an oversight, kept
-- deliberately when this was last reconsidered. This is the one-off escape
-- hatch for a specific account an admin has explicitly decided to trust
-- with the role despite not having a staff email, rather than loosening the
-- domain rule for every account. Off by default; an admin turns it on per
-- account, visibly, before the role grant is attempted.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS consultant_domain_exception BOOLEAN NOT NULL DEFAULT false;
