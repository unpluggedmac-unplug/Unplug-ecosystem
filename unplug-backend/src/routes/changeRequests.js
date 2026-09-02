// THE MEMBER'S SIDE OF A CHANGE REQUEST (spec §10.14).
//
// An admin has asked for specific fields to be changed. The member needs to
// know that happened, which fields, and be able to send it back.
//
// Deliberately its own route rather than an addition to each service's /mine.
// A member wants one answer to "what is waiting on me?", not to check six
// endpoints; and the alternative — the same query written into articles.js,
// events.js, profiles.js and the rest — is the value-stated-in-many-places bug
// that the spine spent five migrations undoing.
//
// WHAT THIS ROUTE DOES NOT DO
//
// It does not edit the submission. Each service already has its own editing
// endpoint with its own validation, and a second way to write an article body
// would be a second set of rules to keep in step. The member edits where they
// always did, then calls resubmit here to say they are done.

const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const { logActivity } = require('./activityLog');
const { isLiveFor } = require('../utils/submissionStatus');
const queue = require('./adminApprovalQueue');
const CR = require('../utils/changeRequests');

const router = express.Router();

// The field list is stored as column names. A member should be shown the same
// labels the admin ticked, so they are resolved back through the approval
// queue's own DETAILS — one definition, read from both sides.
function labelsFor(type, cols) {
  const d = queue.DETAILS[type];
  if (!d) return cols.map((c) => ({ col: c, label: c }));
  return cols.map((c) => {
    const spec = d.fields.find((x) => x.col === c);
    return { col: c, label: spec ? spec.label : c };
  });
}

// GET /change-requests/mine — everything waiting on this member.
//
// Open requests only. Once answered it is history, and history belongs on the
// submission rather than in a to-do list.
router.get('/mine', requireAuth, async (req, res, next) => {
  try {
    const types = Object.keys(CR.OWNER_SQL);
    const out = [];

    // One query per type rather than a union: each type reaches its owner by a
    // different route through the schema, and a union of five different joins
    // would be harder to read than five small queries.
    for (const type of types) {
      const rows = await pool.query(
        `SELECT cr.id, cr.submission_type, cr.submission_id, cr.fields, cr.note, cr.requested_at
           FROM change_requests cr
          WHERE cr.submission_type = $1 AND cr.answered_at IS NULL`,
        [type]
      );
      for (const r of rows.rows) {
        const owner = await CR.ownerOf(type, r.submission_id, pool);
        if (owner !== req.user.id) continue;
        out.push({
          id: r.id,
          type: r.submission_type,
          submissionId: r.submission_id,
          fields: labelsFor(r.submission_type, Array.isArray(r.fields) ? r.fields : []),
          note: r.note,
          requestedAt: r.requested_at,
        });
      }
    }

    out.sort((a, b) => new Date(b.requestedAt) - new Date(a.requestedAt));
    res.json({ changeRequests: out, actionRequired: out.length });
  } catch (err) { next(err); }
});

// POST /change-requests/:id/resubmit — the member says they are done.
//
// Moves the submission to `resubmitted`, which the approval queue selects, so
// it goes back in front of an admin. The request is marked answered, which
// frees the partial unique index for a future one.
router.post('/:id/resubmit', requireAuth, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'A valid id is required.' });

    await client.query('BEGIN');

    // Locked for the transaction: two taps on the button would otherwise both
    // read an open request and both try to answer it.
    const cr = await client.query(
      `SELECT * FROM change_requests WHERE id = $1 FOR UPDATE`, [id]
    );
    if (!cr.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'No such change request.' });
    }
    const row = cr.rows[0];

    if (row.answered_at) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'You have already sent this back.' });
    }

    // Ownership is checked here, not on the id — a change request id is a small
    // integer and guessing one must not let somebody resubmit another member's
    // work.
    const owner = await CR.ownerOf(row.submission_type, row.submission_id, client);
    if (owner !== req.user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'That is not your submission.' });
    }

    const d = queue.DETAILS[row.submission_type];
    if (!d || !isLiveFor('resubmitted', d.table)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This service cannot be resubmitted yet.' });
    }

    const updated = await client.query(
      `UPDATE ${d.table} SET status = 'resubmitted' WHERE id = $1 RETURNING id`,
      [row.submission_id]
    );
    if (!updated.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'That submission no longer exists.' });
    }

    await client.query(
      `UPDATE change_requests SET answered_at = now(), answered_by = $1 WHERE id = $2`,
      [req.user.id, id]
    );

    await client.query('COMMIT');

    await logActivity(req.user.id, 'changes_resubmitted',
      `Sent ${row.submission_type} #${row.submission_id} back for review`);

    res.json({
      resubmitted: true,
      type: row.submission_type,
      submissionId: row.submission_id,
      message: 'Sent back for review. An admin will look at it again.',
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
