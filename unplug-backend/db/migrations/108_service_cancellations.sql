-- Service cancellation requests.
--
-- Nothing like this existed: a member who wanted to stop a service they were
-- paying for had no way to ask, and an admin had no record of it if they did
-- ask by email. This adds the request, the admin decision, and the audit
-- trail — with the stop itself always going through an admin, so a member can
-- never cancel their own paid service and skip the refund conversation.
--
-- Approval stops the service IMMEDIATELY, and any money back is a decision an
-- admin makes and types in. There is deliberately no automatic refund
-- calculation anywhere here: a pro-rata rule that nobody agreed to is worse
-- than a number a person chose.

CREATE TABLE IF NOT EXISTS service_cancellations (
  id                      SERIAL PRIMARY KEY,
  user_id                 INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Matches the payments.linked_type vocabulary so a cancellation, the
  -- service and the payment all name the same thing the same way.
  service_type            VARCHAR(40) NOT NULL,
  service_id              INTEGER NOT NULL,

  -- Copied at request time rather than joined later: what the member was
  -- looking at when they asked is the thing to show back to them, and the
  -- service row can be edited or removed afterwards.
  service_label           VARCHAR(200),
  reference               VARCHAR(120),
  service_submitted_at    TIMESTAMPTZ,
  -- The payment being cancelled, captured at request time. Carried so that a
  -- refund can be tied to it, which is what makes account_credits_payment_once
  -- able to stop the same payment being handed back twice.
  payment_id              INTEGER REFERENCES payments(id) ON DELETE SET NULL,

  requested_effective_date DATE,
  reason                  TEXT,

  status                  VARCHAR(30) NOT NULL DEFAULT 'requested'
                          CHECK (status IN ('requested', 'under_review', 'approved', 'rejected', 'cancelled')),

  admin_user_id           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  admin_note              TEXT,
  -- NULL means no money back. Set by an admin, never computed.
  refund_amount           NUMERIC(10,2),
  decided_at              TIMESTAMPTZ,
  cancelled_at            TIMESTAMPTZ,

  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_service_cancellations_user
  ON service_cancellations (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_service_cancellations_status
  ON service_cancellations (status, created_at DESC);

-- One OPEN request per service at a time. Partial, because a service that was
-- cancelled and later re-purchased must be requestable again — a plain UNIQUE
-- would lock it out forever. This is also what stops a member submitting the
-- same request twenty times and burying the queue.
CREATE UNIQUE INDEX IF NOT EXISTS idx_service_cancellations_one_open
  ON service_cancellations (service_type, service_id)
  WHERE status IN ('requested', 'under_review');

-- Stopping a service sets its existing status to the value that already
-- removes it from every public query ('rejected'), because those queries all
-- filter on status = 'approved' and changing them instead would mean editing
-- read paths across the whole site to add a second exclusion.
--
-- cancelled_at is what keeps that honest: without it, a service the CUSTOMER
-- asked to end is indistinguishable in the admin from one WE turned down, and
-- those are very different conversations to have later.
ALTER TABLE profiles              ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE articles              ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE events                ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE gallery_images        ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE marketplace_listings  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE highlights            ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE ad_slots              ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE competition_entries   ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE top10_entries         ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
