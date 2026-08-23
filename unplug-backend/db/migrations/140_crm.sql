-- The CRM: people, the companies they belong to, the deals in progress, and
-- everything that has happened with each.
--
-- WHY THIS DOES NOT REPLACE WHAT IS ALREADY HERE. There are already people in
-- this database: `users` are members with accounts, `profiles` are directory
-- listings, `inquiries` are messages from the contact form. A CRM that
-- invented a second identity for all of them would mean two records per
-- person, drifting apart from the day they were created — and the first time
-- somebody updated an email address in one place, the CRM would start being
-- quietly wrong.
--
-- So a crm_contact POINTS AT those rows rather than copying them. It is the
-- thread that ties a member account, a directory listing and three enquiries
-- to one human being, and it holds only what none of those hold: which stage
-- of a sale they are at, and what has been said to them.
--
-- Reversal: these tables can be dropped without touching anything that exists
-- today. Nothing outside the CRM reads them.

-- ---------------------------------------------------------------------------
-- Companies
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_companies (
  id           SERIAL PRIMARY KEY,
  name         VARCHAR(200) NOT NULL,
  website      VARCHAR(300),
  industry     VARCHAR(120),
  notes        TEXT,
  -- The directory listing, when this company has one. That is the whole point
  -- of a company record here: an advertiser enquiring is often already a
  -- listed business, and treating them as a stranger is how somebody gets
  -- pitched a package they already pay for.
  profile_id   INTEGER REFERENCES profiles(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_companies_name ON crm_companies (LOWER(name));

-- ---------------------------------------------------------------------------
-- Contacts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_contacts (
  id           SERIAL PRIMARY KEY,

  -- Email is the identity. It is the one thing every form asks for, the one
  -- thing that survives somebody changing their name, and the only sensible
  -- key for "have we met this person before".
  email        VARCHAR(255) NOT NULL,
  full_name    VARCHAR(200),
  phone        VARCHAR(60),

  company_id   INTEGER REFERENCES crm_companies(id) ON DELETE SET NULL,
  -- The member account, when they have one. NOT a copy of it.
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,

  -- WHERE THEY CAME FROM. Recorded once, on first contact, and never
  -- overwritten: the channel that first brought somebody in is the one worth
  -- knowing, and updating it on every later visit would eventually attribute
  -- everybody to "direct" simply because they came back by typing the address.
  source       VARCHAR(60),
  utm_source   VARCHAR(120),
  utm_medium   VARCHAR(120),
  utm_campaign VARCHAR(120),
  referrer_host VARCHAR(200),
  -- NULL means genuinely unknown, and that is a real answer here. Attribution
  -- comes from analytics_sessions, which is only minted after somebody accepts
  -- the consent bar — so a visitor who declined has no source, and recording
  -- them as "Direct" would quietly inflate direct traffic with people who
  -- actually came from Instagram.
  source_known BOOLEAN NOT NULL DEFAULT false,

  -- Lifecycle, kept deliberately short. Anything longer becomes a taxonomy
  -- nobody maintains.
  status       VARCHAR(20) NOT NULL DEFAULT 'lead'
               CHECK (status IN ('lead', 'active', 'customer', 'archived')),

  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One contact per email address. This is what makes "create or update" work
-- rather than producing a new lead every time somebody fills in a form.
CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_contacts_email ON crm_contacts (LOWER(email));
CREATE INDEX IF NOT EXISTS idx_crm_contacts_company ON crm_contacts (company_id);
CREATE INDEX IF NOT EXISTS idx_crm_contacts_status ON crm_contacts (status, last_seen_at DESC);

-- ---------------------------------------------------------------------------
-- Deals
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_deals (
  id           SERIAL PRIMARY KEY,
  contact_id   INTEGER NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,
  company_id   INTEGER REFERENCES crm_companies(id) ON DELETE SET NULL,

  title        VARCHAR(200) NOT NULL,

  -- The pipeline. Fixed rather than configurable on purpose: five stages that
  -- everyone understands beats twelve that each person interprets differently,
  -- and a configurable pipeline is a settings screen plus a migration every
  -- time somebody renames one.
  stage        VARCHAR(20) NOT NULL DEFAULT 'prospect'
               CHECK (stage IN ('prospect', 'contacted', 'proposal', 'won', 'lost')),

  -- Rands, matching every other money column in this database.
  value        NUMERIC(10,2) NOT NULL DEFAULT 0,

  -- How likely, as a percentage. Used for the weighted forecast, which is the
  -- only honest way to answer "what is the pipeline worth" — the raw total
  -- assumes every deal closes.
  probability  INTEGER NOT NULL DEFAULT 10 CHECK (probability BETWEEN 0 AND 100),

  owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,

  -- What kind of sale this is, in this magazine's terms.
  source       VARCHAR(40) NOT NULL DEFAULT 'other'
               CHECK (source IN ('directory_package', 'advertising', 'marketplace',
                                 'edition_download', 'competition', 'event', 'other')),

  -- Ties a deal to what it actually was, once money moved. Loose on purpose:
  -- payments.linked_type already names a dozen kinds of purchase and a foreign
  -- key per kind would be a dozen nullable columns.
  linked_type  VARCHAR(40),
  linked_id    INTEGER,

  expected_close_on DATE,
  closed_at    TIMESTAMPTZ,
  lost_reason  TEXT,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crm_deals_stage ON crm_deals (stage, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_deals_contact ON crm_deals (contact_id);
CREATE INDEX IF NOT EXISTS idx_crm_deals_owner ON crm_deals (owner_user_id, stage);
-- The dashboard's close-rate and revenue-by-period queries.
CREATE INDEX IF NOT EXISTS idx_crm_deals_closed ON crm_deals (closed_at DESC) WHERE closed_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Activities — the timeline
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_activities (
  id           SERIAL PRIMARY KEY,
  contact_id   INTEGER NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,
  deal_id      INTEGER REFERENCES crm_deals(id) ON DELETE SET NULL,

  kind         VARCHAR(20) NOT NULL
               CHECK (kind IN ('note', 'call', 'email', 'meeting', 'form', 'chat', 'system')),
  subject      VARCHAR(255),
  body         TEXT,

  -- NULL for things that happened without a person doing them: a form
  -- submission, an automatic stage change. Those are 'system' or 'form', and
  -- attributing them to whoever happened to be logged in would be a lie the
  -- timeline then tells for ever.
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,

  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crm_activities_contact ON crm_activities (contact_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_activities_deal ON crm_activities (deal_id, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- Tasks
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_tasks (
  id           SERIAL PRIMARY KEY,
  title        VARCHAR(255) NOT NULL,
  notes        TEXT,

  contact_id   INTEGER REFERENCES crm_contacts(id) ON DELETE CASCADE,
  deal_id      INTEGER REFERENCES crm_deals(id) ON DELETE CASCADE,

  assignee_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  due_at       TIMESTAMPTZ,

  -- Completion is a timestamp rather than a flag, because "when was this
  -- done" is a question somebody asks and a boolean cannot answer.
  done_at      TIMESTAMPTZ,
  done_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,

  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The "what is due" query, which is the only one that runs often.
CREATE INDEX IF NOT EXISTS idx_crm_tasks_due ON crm_tasks (due_at) WHERE done_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_tasks_assignee ON crm_tasks (assignee_id, due_at) WHERE done_at IS NULL;

-- ---------------------------------------------------------------------------
-- Tags
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_tags (
  id      SERIAL PRIMARY KEY,
  name    VARCHAR(60) NOT NULL,
  colour  VARCHAR(20) NOT NULL DEFAULT '#6b6b6b'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_tags_name ON crm_tags (LOWER(name));

CREATE TABLE IF NOT EXISTS crm_contact_tags (
  contact_id INTEGER NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,
  tag_id     INTEGER NOT NULL REFERENCES crm_tags(id) ON DELETE CASCADE,
  added_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (contact_id, tag_id)
);

-- ---------------------------------------------------------------------------
-- Linking what already exists
-- ---------------------------------------------------------------------------

-- An enquiry becomes an activity on a contact's timeline, and this is the
-- thread back to the original row. Added to `inquiries` rather than copying
-- the message into the CRM, so there is still exactly one copy of what
-- somebody wrote.
ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS crm_contact_id INTEGER REFERENCES crm_contacts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_inquiries_crm ON inquiries (crm_contact_id);
