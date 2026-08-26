-- Email: lists, consent, suppression, and what actually happened to each send.
--
-- WHAT IS WRONG TODAY, and why this is the first thing built rather than the
-- composer.
--
-- routes/bulkEmail.js selects every member matching a segment and mails them.
-- There is no unsubscribe link in the message, no check of any opt-out, no
-- suppression list and no record of consent. newsletter_subscribers is an
-- email address and a timestamp. Nowhere in this codebase can somebody stop
-- receiving mail.
--
-- That is three problems at once:
--
--   LEGAL. POPIA section 69 requires an opt-out for direct marketing to a South
--   African audience, and GDPR Article 21 requires one for any EU reader.
--   "There is no way to unsubscribe" is not a defensible position.
--
--   DELIVERABILITY. Somebody who cannot unsubscribe marks the mail as spam
--   instead. Enough of those and the sending domain's reputation is gone —
--   at which point the invoices and password resets stop arriving either.
--
--   DECENCY. Somebody asked to stop hearing from a magazine and could not.
--
-- So: consent is recorded with a timestamp and a source, suppression is global
-- and checked on every send, and unsubscribing needs no account and no reply.
--
-- Reversal: these tables can be dropped. bulkEmail.js keeps working exactly as
-- it does now, which is the problem, so the send path is changed to REQUIRE
-- this rather than to use it when present.

-- ---------------------------------------------------------------------------
-- Lists
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_lists (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(120) NOT NULL,
  slug        VARCHAR(120) NOT NULL,
  description TEXT,
  -- Shown on the preference centre so somebody can choose to keep one and drop
  -- another, rather than facing all-or-nothing and choosing nothing.
  public      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_lists_slug ON email_lists (LOWER(slug));

INSERT INTO email_lists (name, slug, description) VALUES
  ('The Friday newsletter', 'newsletter', 'Stories from the week, every Friday.')
  ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Subscriptions, and the consent behind each one
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_subscriptions (
  id           SERIAL PRIMARY KEY,
  email        VARCHAR(255) NOT NULL,
  list_id      INTEGER NOT NULL REFERENCES email_lists(id) ON DELETE CASCADE,

  -- Ties a subscriber to the person, when the person is known. Not required:
  -- somebody can join a mailing list without ever creating a contact record.
  contact_id   INTEGER REFERENCES crm_contacts(id) ON DELETE SET NULL,

  status       VARCHAR(20) NOT NULL DEFAULT 'subscribed'
               CHECK (status IN ('subscribed', 'unsubscribed', 'pending')),

  -- PROOF OF CONSENT. Not decoration: the question "why do you have my email
  -- address" has to have an answer, and "somebody typed it in somewhere" is
  -- not one. What form, when, and from which address.
  consent_source VARCHAR(120),
  consent_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  consent_ip     TEXT,

  unsubscribed_at TIMESTAMPTZ,
  -- Kept, because "I clicked the link in the email" and "an admin removed me"
  -- are different events and the difference matters if anyone asks.
  unsubscribe_reason VARCHAR(40),

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_subs_unique
  ON email_subscriptions (LOWER(email), list_id);
CREATE INDEX IF NOT EXISTS idx_email_subs_list ON email_subscriptions (list_id, status);

-- ---------------------------------------------------------------------------
-- Suppression — the list that overrules everything
-- ---------------------------------------------------------------------------
--
-- GLOBAL AND ABSOLUTE. An address here is never sent to again, by any campaign,
-- any automation, any admin, for any reason. It is checked at the moment of
-- sending rather than when a campaign's recipients are chosen, because somebody
-- who unsubscribes while a send is in progress must not receive the rest of it.
--
-- Transactional mail — a password reset, an invoice — is deliberately NOT
-- routed through this. Somebody who unsubscribed from the newsletter still
-- needs their receipt. The two paths are separate and stay separate.
CREATE TABLE IF NOT EXISTS email_suppressions (
  email       VARCHAR(255) PRIMARY KEY,
  reason      VARCHAR(30) NOT NULL
              CHECK (reason IN ('unsubscribed', 'bounced', 'complained', 'manual', 'invalid')),
  detail      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_suppressions_reason ON email_suppressions (reason, created_at DESC);

-- ---------------------------------------------------------------------------
-- Campaigns
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_campaigns (
  id           SERIAL PRIMARY KEY,
  name         VARCHAR(200) NOT NULL,
  subject      VARCHAR(255) NOT NULL,
  preheader    VARCHAR(255),

  -- The composed blocks, as JSON. Rendered to HTML at send time rather than
  -- stored as HTML, so a fix to the renderer improves every future send
  -- instead of only new ones.
  blocks       JSONB NOT NULL DEFAULT '[]',

  list_id      INTEGER REFERENCES email_lists(id) ON DELETE SET NULL,
  status       VARCHAR(20) NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'cancelled')),
  scheduled_for TIMESTAMPTZ,

  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_email_campaigns_status ON email_campaigns (status, scheduled_for);

-- ---------------------------------------------------------------------------
-- One row per message actually sent
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_sends (
  id           SERIAL PRIMARY KEY,
  campaign_id  INTEGER REFERENCES email_campaigns(id) ON DELETE CASCADE,
  email        VARCHAR(255) NOT NULL,

  status       VARCHAR(20) NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued', 'sent', 'failed', 'skipped')),
  -- Why it was not sent. 'suppressed' is the common and correct one, and being
  -- able to see it is what makes the suppression list trustworthy rather than
  -- mysterious.
  skip_reason  VARCHAR(40),
  provider_id  TEXT,
  error        TEXT,

  -- The per-message token behind the unsubscribe link and the tracking pixel.
  -- Random rather than derived, so one leaked link cannot be used to work out
  -- anybody else's.
  token        TEXT,

  sent_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_sends_campaign ON email_sends (campaign_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_sends_token ON email_sends (token) WHERE token IS NOT NULL;

-- ---------------------------------------------------------------------------
-- What happened afterwards
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_events (
  id          SERIAL PRIMARY KEY,
  send_id     INTEGER REFERENCES email_sends(id) ON DELETE CASCADE,
  kind        VARCHAR(20) NOT NULL
              CHECK (kind IN ('delivered', 'open', 'click', 'bounce', 'complaint', 'unsubscribe')),
  url         TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_events_send ON email_events (send_id, kind);
CREATE INDEX IF NOT EXISTS idx_email_events_kind ON email_events (kind, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- Bringing the existing subscribers across
-- ---------------------------------------------------------------------------
--
-- They gave an address to a newsletter form, so their consent is real — but
-- the source and the exact wording are not recorded anywhere, and inventing
-- them would be worse than admitting it. consent_source says plainly where
-- this came from.
INSERT INTO email_subscriptions (email, list_id, status, consent_source, consent_at)
SELECT ns.email, (SELECT id FROM email_lists WHERE slug = 'newsletter'),
       'subscribed', 'imported from newsletter_subscribers (original source not recorded)',
       ns.subscribed_at
  FROM newsletter_subscribers ns
 WHERE NOT EXISTS (
   SELECT 1 FROM email_subscriptions es
    WHERE LOWER(es.email) = LOWER(ns.email)
      AND es.list_id = (SELECT id FROM email_lists WHERE slug = 'newsletter'))
ON CONFLICT DO NOTHING;
