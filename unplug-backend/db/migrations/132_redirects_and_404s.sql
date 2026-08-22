-- Redirect manager, and a log of what people asked for and did not find.
--
-- WHY A LOG OF MISSES AND NOT JUST A REDIRECT TABLE. A redirect you have to
-- think of in advance is a redirect you will not write. The useful ones come
-- from real traffic: somebody shared an old URL, a printed QR points at a path
-- that moved, a search engine still holds a link from before a rename. Logging
-- the misses turns "add redirects" from a memory exercise into a list.
--
-- WHERE THESE ARE APPLIED. Not in Express. www.unplugnews.com is served by
-- Cloudflare Pages and the API is a different origin, so Express never sees a
-- request for a mistyped page on the public site. A Cloudflare Pages Function
-- asks this table only when the static asset was a genuine 404, which keeps
-- the happy path free of any backend round-trip.

CREATE TABLE IF NOT EXISTS redirects (
  id          SERIAL PRIMARY KEY,

  -- The path as it appears after the domain, always stored with a leading
  -- slash and no query string. Normalised on write so "/About", "about" and
  -- "/about/" cannot become three rows that shadow each other.
  from_path   VARCHAR(500) NOT NULL,

  -- Where to send them. A path on this site, or an absolute https URL.
  to_url      VARCHAR(1000) NOT NULL,

  -- 301 permanent (the default, and what you want for a page that has moved
  -- for good) or 302 temporary. Constrained because these two are the only
  -- ones with a sensible meaning here, and a typo like 303 would be applied
  -- silently by the browser.
  status_code SMALLINT NOT NULL DEFAULT 301 CHECK (status_code IN (301, 302)),

  -- Counted so dead rules can be spotted and retired. A redirect nobody has
  -- followed in a year is clutter; one followed daily is load-bearing.
  hit_count   INTEGER NOT NULL DEFAULT 0,
  last_hit_at TIMESTAMPTZ,

  is_active   BOOLEAN NOT NULL DEFAULT true,
  note        VARCHAR(300),
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One rule per path. Case-insensitive, because a person typing a URL and a
-- person copying one should not land on different rules.
CREATE UNIQUE INDEX IF NOT EXISTS redirects_from_path_key
  ON redirects (LOWER(from_path));

-- The lookup a Pages Function does on a miss: active rule for this path.
CREATE INDEX IF NOT EXISTS redirects_active_lookup
  ON redirects (LOWER(from_path)) WHERE is_active = true;

-- ---------------------------------------------------------------------------
-- What was asked for and not found.
--
-- One row per PATH, not per hit. A single broken link shared widely would
-- otherwise write thousands of rows and bury the handful of distinct problems
-- worth fixing — the same reasoning as rolling up admin notifications.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS not_found_log (
  path        VARCHAR(500) PRIMARY KEY,
  hit_count   INTEGER NOT NULL DEFAULT 1,
  -- Kept so an admin can tell "somebody is linking to this from Facebook"
  -- apart from "one person mistyped it once".
  last_referrer VARCHAR(500),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Set once a redirect has been created for it, so the list of things still
  -- needing attention stays honest without losing the history.
  resolved      BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS not_found_unresolved
  ON not_found_log (resolved, hit_count DESC);
