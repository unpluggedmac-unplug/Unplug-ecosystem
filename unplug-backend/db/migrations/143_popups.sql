-- Popups: an admin-managed thing that interrupts a reader.
--
-- THIS IS THE ONLY FEATURE IN THIS CODEBASE WHOSE PURPOSE IS TO GET IN
-- SOMEBODY'S WAY, so the schema is arranged so that the annoying outcomes are
-- hard to reach by accident rather than merely discouraged.
--
--   ACTIVE DEFAULTS TO FALSE. A popup half-written on a Tuesday and left
--   overnight must not be interrupting readers on Wednesday morning. Turning
--   one on is a deliberate act, the same rule the email automations follow.
--
--   EVERY POPUP CAN BE MADE TO STOP ON ITS OWN. ends_at means a competition
--   popup does not still be shouting about a deadline that passed in March.
--   Without it the failure mode is not a bug anybody reports — it is the site
--   quietly looking abandoned.
--
--   HOW OFTEN IT MAY RETURN IS PART OF THE POPUP, not a global setting. A
--   reader who dismissed something has answered it; the answer has to be
--   remembered for a stated length of time rather than until the tab closes.
--
--   SCROLL DEPTH IS THE TRIGGER. Chosen over exit intent because there is no
--   cursor on a phone — exit intent simply never fires there, which means a
--   popup that "works" in testing on a laptop reaches none of the mobile
--   readers who are most of this audience.
--
-- Reversal: drop both tables. Nothing else references them, and the frontend
-- script degrades to showing nothing when the endpoint returns an empty list.

CREATE TABLE IF NOT EXISTS popups (
  id           SERIAL PRIMARY KEY,
  -- Internal. What the admin calls it in the list, never shown to a reader.
  name         VARCHAR(160) NOT NULL,

  --   newsletter   — an email field; feeds the consent system, not the
  --                  legacy subscribers table
  --   announcement — a message and a button, no form
  --   nominate     — points at /nominate, which is deliberately out of the
  --                  main navigation and needs ways in
  kind         VARCHAR(20) NOT NULL DEFAULT 'newsletter'
               CHECK (kind IN ('newsletter', 'announcement', 'nominate')),

  title        VARCHAR(200) NOT NULL,
  body         TEXT,
  image_url    TEXT,
  button_label VARCHAR(80),
  button_url   TEXT,

  -- Which list a newsletter popup subscribes people to. Null falls back to
  -- the 'newsletter' list, so a popup created without choosing one still
  -- records consent against something real rather than nothing.
  list_id      INTEGER REFERENCES email_lists(id) ON DELETE SET NULL,

  -- How far down the page before it appears, as a percentage. The default is
  -- deliberately not 0: a popup that fires on arrival has interrupted somebody
  -- before they have seen anything worth staying for, and is the single most
  -- reliable way to make a reader leave.
  scroll_percent INTEGER NOT NULL DEFAULT 50
                 CHECK (scroll_percent BETWEEN 5 AND 100),

  -- Where it may appear. An empty array means everywhere; otherwise a list of
  -- the page ids the magazine already uses ('home', 'news', 'articledetail').
  pages        JSONB NOT NULL DEFAULT '[]',

  -- Once dismissed, how long before it may return.
  --   session — until the browser tab is closed
  --   days    — for frequency_days days
  --   once    — never again on this device
  frequency      VARCHAR(10) NOT NULL DEFAULT 'days'
                 CHECK (frequency IN ('session', 'days', 'once')),
  frequency_days INTEGER NOT NULL DEFAULT 30 CHECK (frequency_days BETWEEN 1 AND 365),

  -- OFF UNTIL SOMEBODY SAYS OTHERWISE. See the note at the top.
  active       BOOLEAN NOT NULL DEFAULT false,
  starts_at    TIMESTAMPTZ,
  ends_at      TIMESTAMPTZ,

  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The public endpoint's only query: what is switched on and in date.
CREATE INDEX IF NOT EXISTS idx_popups_live ON popups (active, starts_at, ends_at);

-- ---------------------------------------------------------------------------
-- What happened
-- ---------------------------------------------------------------------------
--
-- WITHOUT THE DISMISSALS THIS IS A VANITY TABLE. Impressions and conversions
-- alone make every popup look like a success — it was seen a thousand times
-- and signed up twelve people, which reads as twelve people gained. The number
-- that matters is how many were interrupted and closed it, because that is the
-- cost being paid for the twelve, and it is the only way to tell a popup that
-- is working from one that is quietly driving readers off the site.
CREATE TABLE IF NOT EXISTS popup_events (
  id          SERIAL PRIMARY KEY,
  popup_id    INTEGER NOT NULL REFERENCES popups(id) ON DELETE CASCADE,
  kind        VARCHAR(20) NOT NULL
              CHECK (kind IN ('impression', 'dismiss', 'convert')),
  -- The same guest session id the analytics already use. NOT required: a
  -- reader who declined analytics consent still gets counted here in
  -- aggregate, with nothing that identifies them, because "how many people
  -- closed this" is not tracking anybody — it is counting a button.
  session_id  TEXT,
  page        VARCHAR(60),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_popup_events_popup ON popup_events (popup_id, kind);
CREATE INDEX IF NOT EXISTS idx_popup_events_when ON popup_events (occurred_at DESC);
