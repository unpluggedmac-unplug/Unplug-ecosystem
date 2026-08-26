-- Drip automations: a sequence of emails sent on a delay after something happens.
--
-- A welcome sequence, a lapsed-reader nudge, the three notes that follow
-- somebody buying an edition. The thing that makes these different from a
-- campaign is that nobody presses send: the system does, at three in the
-- morning, to somebody who is not thinking about us. That is exactly the
-- situation where a bug means hundreds of duplicate emails to real people,
-- so the schema is built to make the bad outcomes impossible rather than
-- unlikely.
--
-- THE FOUR THINGS THIS SCHEMA IS DEFENDING AGAINST:
--
--   1. ENROLLING SOMEBODY TWICE. Somebody who subscribes, unsubscribes and
--      subscribes again must not receive the welcome sequence twice over.
--      One enrolment per person per automation is a UNIQUE INDEX, not a
--      check in application code that a second code path can forget.
--
--   2. SENDING A STEP TWICE. The runner claims a due enrolment by moving it
--      forward in the same UPDATE that selects it, so two overlapping ticks
--      cannot both act on the same row. Without that, one slow send plus one
--      timer is a duplicate.
--
--   3. CARRYING ON AFTER SOMEBODY LEAVES. Unsubscribing cancels every
--      enrolment. The suppression check at send time would catch it anyway,
--      but "the mail was suppressed" and "the sequence stopped" are different
--      states, and only the second is honest about what was asked for.
--
--   4. LOSING TRACK OF WHICH STEP SOMEBODY IS ON when an admin edits the
--      sequence mid-flight. Steps carry an explicit position that does not
--      shift, and an enrolment stores the position it has completed rather
--      than a row id that could be deleted.
--
-- Reversal: drop the three tables. Nothing else references them, and the
-- campaign path in 141 keeps working on its own.

-- ---------------------------------------------------------------------------
-- The automation
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_automations (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(200) NOT NULL,
  description TEXT,

  -- What starts it. Deliberately a short list of things this site actually
  -- does, rather than a general event system nothing emits into.
  --
  --   subscribe — somebody joined the list named by trigger_list_id
  --   signup    — somebody created an Unplug account
  --   purchase  — somebody completed a payment
  --   manual    — an admin enrols people by hand
  trigger     VARCHAR(20) NOT NULL DEFAULT 'subscribe'
              CHECK (trigger IN ('subscribe', 'signup', 'purchase', 'manual')),
  trigger_list_id INTEGER REFERENCES email_lists(id) ON DELETE SET NULL,

  -- OFF BY DEFAULT, and this is the important default in the whole file.
  -- An automation created by mistake, or half-written and left overnight,
  -- must not start mailing anybody. Turning it on is a deliberate act.
  active      BOOLEAN NOT NULL DEFAULT false,

  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_automations_active
  ON email_automations (active, trigger);

-- ---------------------------------------------------------------------------
-- The steps
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_automation_steps (
  id            SERIAL PRIMARY KEY,
  automation_id INTEGER NOT NULL REFERENCES email_automations(id) ON DELETE CASCADE,

  -- Explicit and stable. An enrolment records the position it has reached, so
  -- renumbering positions would move people; the admin routes therefore only
  -- ever append or edit in place, never renumber.
  position      INTEGER NOT NULL,

  -- Hours after the PREVIOUS step, not after enrolment. Written as a delay
  -- between steps because that is how somebody thinks about a sequence
  -- ("then two days later…"), and because inserting a step in the middle then
  -- does not silently reschedule everything after it.
  delay_hours   INTEGER NOT NULL DEFAULT 24 CHECK (delay_hours >= 0),

  subject       VARCHAR(255) NOT NULL,
  preheader     VARCHAR(255),
  blocks        JSONB NOT NULL DEFAULT '[]',

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_steps_position
  ON email_automation_steps (automation_id, position);

-- ---------------------------------------------------------------------------
-- Who is in it, and where they have got to
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_automation_enrolments (
  id            SERIAL PRIMARY KEY,
  automation_id INTEGER NOT NULL REFERENCES email_automations(id) ON DELETE CASCADE,
  email         VARCHAR(255) NOT NULL,
  contact_id    INTEGER REFERENCES crm_contacts(id) ON DELETE SET NULL,

  -- The position of the last step actually sent. 0 means "enrolled, nothing
  -- sent yet", which is why the first step's delay is measured from here.
  last_position INTEGER NOT NULL DEFAULT 0,

  -- When the next step is due. The runner selects on this, so it is the only
  -- index that matters for the tick.
  next_run_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  status        VARCHAR(20) NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'completed', 'cancelled')),
  -- Why it stopped. 'unsubscribed' and 'finished the sequence' look identical
  -- in the numbers otherwise, and they mean opposite things.
  stopped_reason VARCHAR(40),

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ONE ENROLMENT PER PERSON PER AUTOMATION. This is the index that makes
-- double-enrolment impossible rather than merely unlikely: every path that
-- enrols somebody goes through ON CONFLICT DO NOTHING against it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_enrol_unique
  ON email_automation_enrolments (automation_id, LOWER(email));

-- The runner's query: active enrolments that are due. Partial, so the index
-- stays small as completed enrolments accumulate — they are kept rather than
-- deleted, because "did this person already get the welcome sequence" has to
-- be answerable next year.
CREATE INDEX IF NOT EXISTS idx_email_enrol_due
  ON email_automation_enrolments (next_run_at)
  WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- Linking a send back to the step that produced it
-- ---------------------------------------------------------------------------
--
-- email_sends.campaign_id is null for automation mail. Without this column an
-- automation's sends are indistinguishable from anything else in the reporting
-- and there is no way to answer "how is the welcome sequence doing".
ALTER TABLE email_sends ADD COLUMN IF NOT EXISTS automation_step_id INTEGER
  REFERENCES email_automation_steps(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_email_sends_step
  ON email_sends (automation_step_id) WHERE automation_step_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Scheduled campaigns need a claim marker
-- ---------------------------------------------------------------------------
--
-- A campaign moves 'scheduled' -> 'sending' -> 'sent'. The move to 'sending'
-- is the claim, and it happens in the same UPDATE that finds the due campaign
-- so two overlapping ticks cannot both take it. started_at records when, which
-- is what lets a send stuck in 'sending' after a restart be spotted rather than
-- sitting there for ever.
ALTER TABLE email_campaigns ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
