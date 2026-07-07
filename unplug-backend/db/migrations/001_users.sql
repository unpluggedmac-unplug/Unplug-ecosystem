-- Unplug Ecosystem — Phase 3, Step 1: Users, Auth, Roles
-- Run this against a fresh PostgreSQL database before starting the API.

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         VARCHAR(255) NOT NULL UNIQUE,
  phone         VARCHAR(30),
  password_hash TEXT NOT NULL,
  role          VARCHAR(20) NOT NULL DEFAULT 'member'
                CHECK (role IN ('member', 'investor', 'advertiser', 'admin')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Note: 'guest' is not a stored role — anyone without a valid session is
-- treated as a guest at the API layer per the permissions matrix in the
-- Master Blueprint (Section 7) and the Backend Spec (Section 4).

CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);
CREATE INDEX IF NOT EXISTS idx_users_role ON users (role);

-- The initial admin account is created by `npm run migrate` (see db/migrate.js),
-- which hashes a real password with bcrypt rather than hardcoding one here.
