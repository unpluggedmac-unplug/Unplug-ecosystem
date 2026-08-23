-- Addresses, ranges and accounts that are allowed in or kept out.
--
-- WHY IN THE DATABASE RATHER THAN A CONFIG FILE. A block is something you need
-- to apply at three in the morning, from a phone, while something is going on.
-- A config file means a deploy, and a deploy is the thing you cannot do at
-- three in the morning from a phone.
--
-- ALLOW WINS OVER BLOCK, ALWAYS. The realistic disaster here is not an
-- attacker slipping past a rule — Cloudflare sits in front of the site and
-- catches most of that anyway. It is an admin blocking a range that turns out
-- to contain their own office, or the whole of a mobile network in Gauteng,
-- and locking themselves out of the tool they would use to undo it. The allow
-- list is the way back in, and it is checked first.
--
-- Reversal: DROP TABLE access_rules. The middleware finds no rules and lets
-- everything through, which is how the site behaves today.

CREATE TABLE IF NOT EXISTS access_rules (
  id          SERIAL PRIMARY KEY,

  -- 'block' or 'allow'. Allow is not "let this address do anything" — it is
  -- "never block this one", an exemption from the rules below it.
  effect      VARCHAR(10) NOT NULL CHECK (effect IN ('block', 'allow')),

  -- What is being matched:
  --   'ip'      a single address, v4 or v6
  --   'cidr'    a range, e.g. 41.0.0.0/8
  --   'account' an email address; the person, wherever they connect from
  --   'country' a two-letter code, needs MaxMind (see below)
  kind        VARCHAR(10) NOT NULL CHECK (kind IN ('ip', 'cidr', 'account', 'country')),

  -- The address, range, email or country code. Stored as text rather than
  -- INET so that all four kinds live in one table and one index; the
  -- application parses according to `kind`.
  value       TEXT NOT NULL,

  -- Why this rule exists. NOT NULL on purpose: an unexplained block is one
  -- nobody will ever dare remove, and the list becomes permanent scar tissue.
  reason      TEXT NOT NULL,

  -- When it should stop applying. NULL is permanent. A temporary block is the
  -- right answer far more often than people reach for it — most abuse stops,
  -- and a rule that expires cannot be forgotten.
  expires_at  TIMESTAMPTZ,

  created_by  INTEGER REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Whether this rule has ever actually matched anything. A list of rules that
  -- have never fired is a list of guesses, and knowing which is which is what
  -- lets somebody prune it later with any confidence.
  hit_count   INTEGER NOT NULL DEFAULT 0,
  last_hit_at TIMESTAMPTZ
);

-- The same value must not be both allowed and blocked twice over; one rule per
-- effect per value.
CREATE UNIQUE INDEX IF NOT EXISTS idx_access_rules_unique
  ON access_rules (effect, kind, LOWER(value));

-- The lookup runs on every request and filters on expiry, so expires_at is
-- part of the index rather than a predicate over it.
--
-- NOT a partial index with "WHERE expires_at > now()". Postgres refuses that
-- outright — now() is STABLE, not IMMUTABLE, and an index predicate must be
-- IMMUTABLE, because an index whose membership changed with the clock could
-- never be kept correct. Worth spelling out: every migration in this codebase
-- re-runs on every deploy, so an index Postgres rejects does not fail once, it
-- fails every deploy from then on and blocks all the migrations behind it.
CREATE INDEX IF NOT EXISTS idx_access_rules_live
  ON access_rules (kind, effect, expires_at);

-- A record of what was actually refused, so an admin can see whether a rule is
-- doing anything and what it caught.
CREATE TABLE IF NOT EXISTS access_denials (
  id          SERIAL PRIMARY KEY,
  rule_id     INTEGER REFERENCES access_rules(id) ON DELETE SET NULL,
  ip_address  TEXT,
  path        TEXT,
  user_agent  TEXT,
  -- 'rule' when an access_rules entry matched, or the name of the WAF check
  -- that fired: 'sqli', 'traversal', 'xss', 'oversize'.
  denied_by   VARCHAR(20) NOT NULL DEFAULT 'rule',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_access_denials_created ON access_denials (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_access_denials_ip ON access_denials (ip_address, created_at DESC);
