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
const { findPaidPayment, balanceFor, RESOURCE_PAYMENT_TYPES } = require('../utils/accountCredit');

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
    // title/alt_text/link_url/link_type/display_order/visibility are the admin
    // Gallery Management fields (migration 061) — editable regardless of who
    // originally submitted the image, per spec §27.
    editable: ['caption', 'supplied_by', 'image_url', 'title', 'alt_text',
               'link_url', 'link_type', 'display_order', 'visibility'],
  },
  articles: {
    table: 'articles',
    label: 'title',
    // Includes the feature image (banner_image_url) and the SEO/editorial
    // fields so an already-published article can be fully corrected here, not
    // just its headline and body. Paste an image path/URL to swap the feature
    // image; to upload a brand-new file, the "Write an article" editor's
    // picklist opens the same article with a file-upload control.
    editable: ['title', 'body', 'kicker_supplied_by', 'banner_image_url',
               'seo_title', 'subtitle', 'meta_description', 'conclusion',
               'cta_label', 'cta_url', 'slug'],
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

// POST /admin/content/gallery — admin adds a brand-new Gallery image directly
// (owner_type 'general', no owner_id, no payment/bundle). Skips the member
// submission/payment queue entirely, per spec §13.
router.post('/gallery', requireRole('admin'), async (req, res, next) => {
  try {
    const imageUrl = (req.body.imageUrl || '').trim();
    if (!imageUrl) return res.status(400).json({ error: 'An image is required.' });
    const visibility = ['draft', 'published', 'unpublished', 'archived'].includes(req.body.visibility)
      ? req.body.visibility : 'published';
    const linkType = ['external', 'article', 'profile', 'event', 'investor', 'none'].includes(req.body.linkType)
      ? req.body.linkType : null;
    const displayOrder = Number.isInteger(Number(req.body.displayOrder)) ? Number(req.body.displayOrder) : 0;

    const result = await pool.query(
      `INSERT INTO gallery_images
         (owner_type, image_url, title, caption, alt_text, link_url, link_type,
          display_order, visibility, status, updated_at, updated_by)
       VALUES ('general', $1, $2, $3, $4, $5, $6, $7, $8, 'approved', now(), $9)
       RETURNING *`,
      [
        imageUrl,
        (req.body.title || '').trim() || null,
        (req.body.description || req.body.caption || '').trim() || null,
        (req.body.altText || '').trim() || null,
        (req.body.linkUrl || '').trim() || null,
        linkType,
        displayOrder,
        visibility,
        req.user.id,
      ]
    );
    res.status(201).json({ item: result.rows[0] });
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

    // Gallery-specific field validation (visibility / link_type / display_order)
    // — not a DB CHECK constraint, so an invalid value is a clean 400 here
    // rather than either silently accepted or a constraint error.
    if (req.params.resource === 'gallery') {
      if (req.body.visibility !== undefined && req.body.visibility !== '' && req.body.visibility !== null
          && !['draft', 'published', 'unpublished', 'archived'].includes(req.body.visibility)) {
        return res.status(400).json({ error: 'visibility must be draft, published, unpublished or archived.' });
      }
      if (req.body.link_type !== undefined && req.body.link_type !== '' && req.body.link_type !== null
          && !['external', 'article', 'profile', 'event', 'investor', 'none'].includes(req.body.link_type)) {
        return res.status(400).json({ error: 'link_type must be external, article, profile, event, investor or none.' });
      }
      if (req.body.display_order !== undefined && req.body.display_order !== '' && req.body.display_order !== null
          && !Number.isInteger(Number(req.body.display_order))) {
        return res.status(400).json({ error: 'display_order must be a whole number.' });
      }
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
      if (col === 'display_order' && value !== null) value = Number(value);
      values.push(value);
      sets.push(`${col} = $${values.length}`);
    });

    if (sets.length === 0) {
      return res.status(400).json({ error: 'No editable fields were supplied.' });
    }

    // Stamp who changed a gallery item and when — the table has no updated_at
    // trigger, and this is the only write path that touches gallery content.
    if (req.params.resource === 'gallery') {
      values.push(new Date());
      sets.push(`updated_at = $${values.length}`);
      values.push(req.user.id);
      sets.push(`updated_by = $${values.length}`);
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

// GET /admin/content/:resource/:id/payment — what would happen if this were
// declined. Lets the dashboard show the real amount on the button instead of
// asking the admin to click and find out.
router.get('/:resource/:id/payment', requireRole('admin'), async (req, res, next) => {
  try {
    const spec = resourceFor(req, res);
    if (!spec) return;
    const id = idFor(req, res);
    if (id === null) return;

    if (!RESOURCE_PAYMENT_TYPES[req.params.resource]) {
      return res.json({ payable: false });
    }
    const payment = await findPaidPayment(req.params.resource, id);
    if (!payment) return res.json({ payable: true, payment: null });

    res.json({
      payable: true,
      payment: {
        id: payment.id,
        amount: Number(payment.amount),
        alreadyCredited: !!payment.credited_at,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /admin/content/:resource/:id/decline-with-credit
//
// The decline path from the Refund & Cancellation Policy: reject the
// submission and put what they paid back on their account as credit, in one
// action so the two can't come apart.
//
// Both writes plus the payment flag happen in a single transaction. Rejecting
// the item and then failing to credit would take someone's money for something
// we refused to publish, which is the exact failure this endpoint exists to
// prevent.
router.post('/:resource/:id/decline-with-credit', requireRole('admin'), async (req, res, next) => {
  const spec = resourceFor(req, res);
  if (!spec) return;
  const id = idFor(req, res);
  if (id === null) return;

  if (spec.hasStatus === false) {
    return res.status(400).json({ error: 'This content type is not something that gets approved or paid for.' });
  }
  if (!RESOURCE_PAYMENT_TYPES[req.params.resource]) {
    return res.status(400).json({ error: 'This content type has no paid submissions, so there is nothing to credit.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const payment = await findPaidPayment(req.params.resource, id, client);
    if (!payment) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        error: 'No confirmed payment was found for this submission, so there is nothing to credit. Reject it normally instead.',
      });
    }
    if (payment.credited_at) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'This payment has already been credited back to the member. Nothing further was done.',
      });
    }

    // The unique index on payment_id is the real protection against a double
    // credit; this insert is what trips it if two requests race.
    await client.query(
      `INSERT INTO account_credits (user_id, amount, reason, note, payment_id, created_by)
       VALUES ($1, $2, 'declined_submission', $3, $4, $5)`,
      [
        payment.user_id,
        payment.amount,
        (req.body.note || '').trim() || `Declined ${req.params.resource} #${id}`,
        payment.id,
        req.user.id,
      ]
    );

    await client.query('UPDATE payments SET credited_at = now() WHERE id = $1', [payment.id]);

    const updated = await client.query(
      `UPDATE ${spec.table} SET status = 'rejected' WHERE id = $1 RETURNING id`,
      [id]
    );
    if (updated.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'That item no longer exists.' });
    }

    await client.query('COMMIT');

    const balance = await balanceFor(payment.user_id);
    res.json({
      declined: true,
      credited: Number(payment.amount),
      userId: payment.user_id,
      newBalance: balance,
      message: `Declined. R${Number(payment.amount).toFixed(2)} was added to their account as credit.`,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // The unique index firing means another request credited this payment
    // first. That's the guard working, not a server fault.
    if (err && err.code === '23505') {
      return res.status(409).json({ error: 'This payment has already been credited back to the member.' });
    }
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
module.exports.RESOURCES = RESOURCES;
