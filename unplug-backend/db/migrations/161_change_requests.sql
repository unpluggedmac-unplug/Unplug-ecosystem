-- Spec §10.14 — asking a member to change specific fields.
--
-- An admin reviewing a submission has had two answers available: approve, or
-- reject. There was no way to say "the cover image is wrong, everything else is
-- fine" — so a fixable submission had to be refused outright, and the member
-- had to start again without being told what was wrong.
--
-- §10.14 asks for a third answer: name the fields that need changing, hand it
-- back, and let the member edit ONLY those.
--
-- WHY A TABLE RATHER THAN COLUMNS ON EACH SUBMISSION
--
-- Nine tables carry submissions. Adding requested_fields, request_note,
-- requested_by and requested_at to every one of them would be thirty-six
-- columns holding one idea, and the spine spent five migrations establishing
-- that a thing said in nine places drifts. One table, keyed by the submission
-- it refers to.
--
-- submission_type is the approval queue's own key for a kind of submission
-- ('article', 'event', 'directory_profile'), not a table name. The queue
-- already maps those to tables and to the fields an admin may edit, and that
-- map is a whitelist in code — so nothing in a request ever names a table or a
-- column here either.
--
-- ONE OPEN REQUEST AT A TIME
--
-- The partial unique index is the real rule. Two open requests on one
-- submission would mean a member seeing two different lists of what to fix, and
-- an admin unable to tell which one was answered. Once answered, a request is
-- kept — the history of what was asked and when is the point — and a new one
-- may be opened.

CREATE TABLE IF NOT EXISTS change_requests (
  id              SERIAL PRIMARY KEY,

  submission_type VARCHAR(40) NOT NULL,
  submission_id   INTEGER NOT NULL,

  -- The columns the admin ticked. Validated against the approval queue's
  -- editable-field whitelist before it is written, so this can only ever hold
  -- names that whitelist already allows.
  fields          JSONB NOT NULL DEFAULT '[]',

  -- What the admin actually wants. The field list says WHERE; this says WHAT.
  note            TEXT,

  requested_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  requested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Set when the member sends it back. Null means still waiting on them.
  answered_at     TIMESTAMPTZ,
  answered_by     INTEGER REFERENCES users(id) ON DELETE SET NULL
);

-- One open request per submission. See the note above: this is the rule, not
-- an optimisation.
CREATE UNIQUE INDEX IF NOT EXISTS change_requests_one_open
  ON change_requests (submission_type, submission_id)
  WHERE answered_at IS NULL;

-- The member's "what am I being asked to fix" query, and the admin's history
-- of a single submission.
CREATE INDEX IF NOT EXISTS idx_change_requests_submission
  ON change_requests (submission_type, submission_id, requested_at DESC);
