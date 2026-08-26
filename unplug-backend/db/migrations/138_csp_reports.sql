-- Content Security Policy violation reports.
--
-- The site sends a Report-Only header carrying the STRICT policy it cannot yet
-- enforce, and browsers post here whenever that policy would have blocked
-- something. Nothing is blocked; this is evidence-gathering.
--
-- WHAT IT IS FOR. The obstacle to a strict script-src is 213 inline event
-- handlers spread across six pages. "213" is a grep count, not a work plan —
-- some are on screens nobody uses, some fire constantly. These reports say
-- which ones REAL PEOPLE actually trigger, so the conversion can be done in
-- the order that matters instead of alphabetically.
--
-- ONE ROW PER DISTINCT VIOLATION, with a counter. A single reader loading a
-- single page can produce dozens of identical reports, and a table with a row
-- per report would be mostly duplicates within a day.
--
-- Reversal: DROP TABLE csp_reports, and remove the Report-Only header from
-- _headers. Nothing depends on either.

CREATE TABLE IF NOT EXISTS csp_reports (
  id                 SERIAL PRIMARY KEY,

  -- Which rule would have blocked it, e.g. "script-src-elem".
  directive          TEXT NOT NULL,
  -- What was blocked. Often "inline" rather than a URL, which is precisely the
  -- case being counted here.
  blocked_uri        TEXT NOT NULL DEFAULT '',
  -- The page it happened on, with any query string removed: the same violation
  -- on ?p=news and ?p=directory is the same violation.
  document_uri       TEXT NOT NULL DEFAULT '',
  -- The first bit of the offending code, when the browser sends it. This is
  -- what identifies WHICH handler needs converting.
  sample             TEXT,

  hit_count          INTEGER NOT NULL DEFAULT 1,
  first_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The dedupe key. A hash rather than the columns themselves because a
-- document_uri can be long and the sample longer, and a unique index over both
-- would be near the size of the table.
ALTER TABLE csp_reports ADD COLUMN IF NOT EXISTS fingerprint TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_csp_reports_fingerprint ON csp_reports (fingerprint);
CREATE INDEX IF NOT EXISTS idx_csp_reports_seen ON csp_reports (last_seen_at DESC);
