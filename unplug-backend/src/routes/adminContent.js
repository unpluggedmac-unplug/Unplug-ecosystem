// Admin list / edit / delete, for every reviewable content type.
//
// Until now each type had approve and reject and nothing else: no way to see
// what had already been approved, fix a typo in it, or take it down. That is
// eleven content types, and writing eleven near-identical trios of handlers
// is how they drift apart — one gets a fix, the others don't.
//
// So the resource is a parameter and the behaviour lives in one place. The
// critical part is that the parameter can never reach SQL as text: table and
// column names cannot be parameterised by the driver, so a resource name
// taken from the URL and interpolated into a query is SQL injection with
// extra steps. Everything below is looked up in the hardcoded RESOURCES map
// and an unknown key is a 404 — the request's own strings are never used to
// build SQL.
const express = require('express');
const pool = require('../db');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

// editable: the only columns an admin may change through this route. Deliberately
//   excludes status (approve/reject own it), ids, foreign keys and created_at —
//   editing is for fixing content, not for rewriting who something belongs to.
// label: the human-readable column, used for confirmation messages.
// joins/extra: read-only context shown in the list.
const RESOURCES = {
  profiles: {
    table: 'profiles',
    label: 'display_name',
    // slug is left out on purpose: it's the public URL, and silently changing
    // it would break every link already shared to that profile.
    editable: ['display_name', 'bio', 'achievements', 'career', 'quote',
               'contact_email', 'contact_phone', 'contact_website'],
  },
  gallery: {
    table: 'gallery_images',
    label: 'caption',
    editable: ['caption', 'supplied_by', 'image_url'],
  },
  articles: {
    table: 'articles',
    label: 'title',
    editable: ['title', 'body', 'kicker_supplied_by'],
  },
  events: {
    table: 'events',
    label: 'name',
    editable: ['name', 'event_date', 'venue', 'description'],
  },
  investors: {
    table: 'investors',
    label: 'name',
    editable: ['name', 'contact_email'],
  },
  marketplace: {
    table: 'marketplace_listings',
    label: 'headline',
    editable: ['headline', 'poster_image_url', 'active_from', 'active_to'],
  },
  highlights: {
    table: 'highlights',
    label: 'target_type',
    editable: ['start_date', 'end_date'],
  },
  entries: {
    table: 'competition_entries',
    label: 'id',
    editable: [],
  },
  'top10-entries': {
    table: 'top10_entries',
    label: 'id',
    editable: [],
  },
  // The editions calendar has no status column — a save-the-date is either on
  // the calendar or it isn't. It is here for the edit and delete it was
  // missing, and hasStatus keeps the status filter off it.
  edcal: {
    table: 'edition_calendar',
    label: 'title',
    editable: ['event_date', 'title', 'description'],
    hasStatus: false,
  },
};

function resourceFor(req, res) {
  const spec = RESOURCES[req.params.resource];
  if (!spec) {
    res.status(404).json({ error: 'Unknown content type.' });
    return null;
  }
  return spec;
}

function idFor(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ error: 'A valid id is required.' });
    return null;
  }
  return id;
}

// GET /admin/content/:resource?status=approved
//
// The counterpart to the existing /pending lists: this one can show any
// status, so approved items stop being invisible the moment they're approved.
router.get('/:resource', requireRole('admin'), async (req, res, next) => {
  try {
    const spec = resourceFor(req, res);
    if (!spec) return;

    const params = [];
    let where = '';
    if (spec.hasStatus !== false && req.query.status) {
      // Compared against a fixed set rather than passed through, so an unknown
      // status is a clear 400 instead of a silently empty list.
      const allowed = ['awaiting_payment', 'pending', 'approved', 'rejected'];
      if (!allowed.includes(req.query.status)) {
        return res.status(400).json({ error: 'Unknown status filter.' });
      }
      params.push(req.query.status);
      where = 'WHERE status = $1';
    }

    const result = await pool.query(
      `SELECT * FROM ${spec.table} ${where} ORDER BY created_at DESC LIMIT 300`,
      params
    );
    res.json({ items: result.rows, editable: spec.editable });
  } catch (err) {
    next(err);
  }
});

// PATCH /admin/content/:resource/:id — fix the content of an existing item.
//
// Only the columns in the resource's editable list are touched, and only ones
// actually present in the request, so a partial edit doesn't blank the fields
// it left out.
router.patch('/:resource/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const spec = resourceFor(req, res);
    if (!spec) return;
    const id = idFor(req, res);
    if (id === null) return;

    if (spec.editable.length === 0) {
      return res.status(400).json({ error: 'This content type has nothing that can be edited directly.' });
    }

    const sets = [];
    const values = [];
    spec.editable.forEach((col) => {
      if (!Object.prototype.hasOwnProperty.call(req.body, col)) return;
      let value = req.body[col];
      if (typeof value === 'string') {
        value = value.trim();
        if (value === '') value = null;
      }
      values.push(value);
      sets.push(`${col} = $${values.length}`);
    });

    if (sets.length === 0) {
      return res.status(400).json({ error: 'No editable fields were supplied.' });
    }

    values.push(id);
    const result = await pool.query(
      `UPDATE ${spec.table} SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'That item no longer exists.' });
    res.json({ item: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /admin/content/:resource/:id
//
// A real delete, not a status change — rejecting hides something, and there
// are things (a submission sent by mistake, an image that shouldn't be stored
// at all) that should not be kept hidden. Irreversible, so the admin UI
// confirms first.
//
// Dependent rows (sections, comments, saves, votes) cascade. The payment does
// NOT: payments.linked_id is a plain integer with no foreign key, so deleting
// a paid-for item leaves its payment record standing. That is the right way
// round — the money changed hands and the books should say so — but it means
// deleting something someone paid for does not refund them.
router.delete('/:resource/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const spec = resourceFor(req, res);
    if (!spec) return;
    const id = idFor(req, res);
    if (id === null) return;

    const result = await pool.query(`DELETE FROM ${spec.table} WHERE id = $1 RETURNING id`, [id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'That item no longer exists.' });
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.RESOURCES = RESOURCES;
