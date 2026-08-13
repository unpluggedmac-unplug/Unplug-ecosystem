// Service cancellation requests.
//
// A member asks; an admin decides. There is no path here by which a member
// stops their own paid service — that is the whole point of the feature, and
// it is enforced by there being no endpoint that changes a service's status
// outside the admin decision below.
//
// Approving stops the service immediately and, if the admin chose to give
// money back, issues account credit in the SAME transaction. A cancellation
// recorded as done with the service still live, or credit issued for a
// service that never stopped, are both worse than the request just failing.
const express = require('express');
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logActivity } = require('./activityLog');

const router = express.Router();

// Every service a member can ask to cancel.
//
// `stop` is written as SQL fragments with no interpolated request data — the
// service type is looked up in this hardcoded map and an unknown key is a
// 400, so nothing from the request ever reaches a query as text.
//
// `ownerColumn` is how we prove the requester owns the thing. Where a table
// has no owner (a gallery image, a highlight, a marketplace poster), the
// payment that bought it does, and ownerViaPayment says so.
const CANCELLABLE = {
  profile_package: {
    label: 'Directory Listing', table: 'profiles', nameColumn: 'display_name',
    ownerColumn: 'user_id', paymentTypes: ['profile_package', 'profile_upgrade'],
    stop: `UPDATE profiles SET status = 'rejected', cancelled_at = now(), updated_at = now() WHERE id = $1`,
  },
  article_publish: {
    label: 'Article', table: 'articles', nameColumn: 'title',
    ownerColumn: 'author_user_id', paymentTypes: ['article_publish'],
    stop: `UPDATE articles SET status = 'rejected', cancelled_at = now() WHERE id = $1`,
  },
  event_listing: {
    label: 'Event', table: 'events', nameColumn: 'name',
    ownerColumn: 'organizer_user_id', paymentTypes: ['event_listing'],
    stop: `UPDATE events SET status = 'rejected', cancelled_at = now() WHERE id = $1`,
  },
  gallery_bundle: {
    label: 'Gallery Image', table: 'gallery_images', nameColumn: 'caption',
    ownerColumn: null, paymentTypes: ['gallery_bundle'],
    stop: `UPDATE gallery_images SET status = 'rejected', cancelled_at = now() WHERE id = $1`,
  },
  marketplace_listing: {
    label: 'Marketplace Poster', table: 'marketplace_listings', nameColumn: 'headline',
    ownerColumn: null, paymentTypes: ['marketplace_listing'],
    stop: `UPDATE marketplace_listings SET status = 'rejected', cancelled_at = now() WHERE id = $1`,
  },
  highlight: {
    label: 'Highlight', table: 'highlights', nameColumn: null,
    ownerColumn: null, paymentTypes: ['highlight'],
    stop: `UPDATE highlights SET status = 'rejected', cancelled_at = now() WHERE id = $1`,
  },
  ad_banner: {
    label: 'Page Banner', table: 'ad_slots', nameColumn: 'name',
    ownerColumn: 'owner_user_id', paymentTypes: ['ad_banner'],
    // Banners are the one type with a second switch: is_active is what the
    // public page actually reads, so leaving it true would keep a cancelled
    // banner on the site regardless of its moderation status.
    stop: `UPDATE ad_slots SET moderation_status = 'rejected', is_active = false, cancelled_at = now(), updated_at = now() WHERE id = $1`,
  },
  competition_entry: {
    label: 'Competition Entry', table: 'competition_entries', nameColumn: 'manual_name',
    ownerColumn: null, paymentTypes: ['competition_entry'],
    stop: `UPDATE competition_entries SET status = 'rejected', cancelled_at = now() WHERE id = $1`,
  },
  top10_entry: {
    label: 'Top 10 Entry', table: 'top10_entries', nameColumn: null,
    ownerColumn: null, paymentTypes: ['top10_entry'],
    stop: `UPDATE top10_entries SET status = 'rejected', cancelled_at = now() WHERE id = $1`,
  },
};

// Returns the service row plus who owns it and what they paid, or an error
// string. Ownership is checked against the service's own owner column when it
// has one, and otherwise against the payment that bought it.
async function loadService(serviceType, serviceId, client = pool) {
  const cfg = CANCELLABLE[serviceType];
  if (!cfg) return { error: 'That is not a service that can be cancelled.' };

  const nameSelect = cfg.nameColumn ? `s.${cfg.nameColumn} AS label` : `NULL AS label`;
  const ownerSelect = cfg.ownerColumn ? `s.${cfg.ownerColumn} AS owner_id` : `NULL::integer AS owner_id`;
  const result = await client.query(
    `SELECT s.id, ${nameSelect}, ${ownerSelect}, s.created_at,
            pay.id AS payment_id, pay.user_id AS payer_id, pay.gateway_reference, pay.amount, pay.status AS payment_status
       FROM ${cfg.table} s
       LEFT JOIN LATERAL (
         SELECT p.id, p.user_id, p.gateway_reference, p.amount, p.status
           FROM payments p
          WHERE p.linked_type IN (${cfg.paymentTypes.map((t) => `'${t}'`).join(', ')})
            AND p.linked_id = s.id
          ORDER BY p.created_at DESC LIMIT 1
       ) pay ON TRUE
      WHERE s.id = $1`,
    [serviceId]
  );
  if (result.rows.length === 0) return { error: 'That service no longer exists.' };
  const row = result.rows[0];
  return { cfg, row, ownerId: row.owner_id || row.payer_id || null };
}

// POST /cancellations — a member asks to cancel one of their services.
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const serviceType = String(req.body.serviceType || '').trim();
    const serviceId = Number(req.body.serviceId);
    const reason = String(req.body.reason || '').trim();
    const requestedDate = req.body.requestedEffectiveDate || null;

    if (!Number.isInteger(serviceId) || serviceId <= 0) {
      return res.status(400).json({ error: 'Which service do you want to cancel?' });
    }

    const found = await loadService(serviceType, serviceId);
    if (found.error) return res.status(404).json({ error: found.error });

    // An admin can file on a member's behalf (they phone in); anyone else must
    // own the service. Checked here rather than trusted from the body, so a
    // crafted request cannot cancel somebody else's listing.
    if (req.user.role !== 'admin' && found.ownerId !== req.user.id) {
      return res.status(403).json({ error: 'That service belongs to a different account.' });
    }

    const result = await pool.query(
      `INSERT INTO service_cancellations
         (user_id, service_type, service_id, service_label, reference, service_submitted_at,
          payment_id, requested_effective_date, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        found.ownerId || req.user.id, serviceType, serviceId,
        found.row.label || CANCELLABLE[serviceType].label,
        found.row.gateway_reference || null, found.row.created_at,
        found.row.payment_id || null,
        requestedDate || null, reason || null,
      ]
    ).catch((err) => {
      // idx_service_cancellations_one_open
      if (err.code === '23505') return null;
      throw err;
    });

    if (!result) {
      return res.status(409).json({ error: 'A cancellation request for this service is already open — we are reviewing it.' });
    }

    res.status(201).json({
      request: result.rows[0],
      message: 'Cancellation requested. Our team will review it and confirm — the service stays active until then.',
    });
  } catch (err) {
    next(err);
  }
});

// GET /cancellations/mine — a member's own requests and where each one is up to.
router.get('/mine', requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, service_type, service_id, service_label, reference, service_submitted_at,
              requested_effective_date, reason, status, admin_note, refund_amount,
              decided_at, cancelled_at, created_at
         FROM service_cancellations
        WHERE user_id = $1
        ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json({ requests: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /cancellations/admin?status=&q=
router.get('/admin', requireRole('admin'), async (req, res, next) => {
  try {
    const conditions = [];
    const values = [];
    if (req.query.status) { values.push(req.query.status); conditions.push(`c.status = $${values.length}`); }
    if (req.query.q) {
      values.push(`%${req.query.q}%`);
      conditions.push(`(c.service_label ILIKE $${values.length} OR c.reference ILIKE $${values.length} OR u.email ILIKE $${values.length})`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT c.*, u.email, u.full_name, a.email AS admin_email
         FROM service_cancellations c
         JOIN users u ON u.id = c.user_id
         LEFT JOIN users a ON a.id = c.admin_user_id
         ${where}
        ORDER BY c.created_at DESC
        LIMIT 500`,
      values
    );
    res.json({ requests: result.rows });
  } catch (err) {
    next(err);
  }
});

// PATCH /cancellations/admin/:id — the admin decision.
//
// action: 'review'  -> under_review, nothing else happens
//         'reject'  -> rejected, service untouched
//         'approve' -> service stopped NOW, optional credit issued, cancelled
router.patch('/admin/:id', requireRole('admin'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    const action = String(req.body.action || '').trim();
    const note = String(req.body.adminNote || '').trim();

    if (!['review', 'approve', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'action must be review, approve or reject.' });
    }

    await client.query('BEGIN');

    // FOR UPDATE: two admins approving the same request at once would
    // otherwise both stop the service and both issue credit.
    const existing = await client.query(
      'SELECT * FROM service_cancellations WHERE id = $1 FOR UPDATE', [id]
    );
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'That cancellation request no longer exists.' });
    }
    const request = existing.rows[0];

    if (['cancelled', 'rejected'].includes(request.status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `This request has already been ${request.status === 'cancelled' ? 'approved and actioned' : 'rejected'}.` });
    }

    if (action === 'review') {
      await client.query(
        `UPDATE service_cancellations SET status = 'under_review', admin_user_id = $2,
                admin_note = COALESCE(NULLIF($3, ''), admin_note), updated_at = now()
          WHERE id = $1`,
        [id, req.user.id, note]
      );
      await client.query('COMMIT');
      return res.json({ status: 'under_review', message: 'Marked as under review. Nothing has been cancelled yet.' });
    }

    if (action === 'reject') {
      await client.query(
        `UPDATE service_cancellations SET status = 'rejected', admin_user_id = $2,
                admin_note = COALESCE(NULLIF($3, ''), admin_note), decided_at = now(), updated_at = now()
          WHERE id = $1`,
        [id, req.user.id, note]
      );
      await client.query('COMMIT');
      await logActivity(req.user.id, 'cancellation_rejected',
        `Rejected cancellation #${id} for ${request.service_type} #${request.service_id}`
        + `${note ? '. Note: ' + note : ''}`).catch(() => {});
      return res.json({ status: 'rejected', message: 'Request rejected. The service is unchanged.' });
    }

    // --- approve -------------------------------------------------------
    const cfg = CANCELLABLE[request.service_type];
    if (!cfg) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This request names a service type that can no longer be cancelled automatically.' });
    }

    const refundRaw = req.body.refundAmount;
    const refund = refundRaw === null || refundRaw === undefined || refundRaw === ''
      ? null : Number(refundRaw);
    if (refund !== null && (!Number.isFinite(refund) || refund < 0)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'The refund amount must be a positive number, or left blank for no refund.' });
    }

    const stopped = await client.query(cfg.stop, [request.service_id]);
    if (stopped.rowCount === 0) {
      // The service is already gone. The request must not be left open
      // forever, but nor should we claim to have stopped something.
      await client.query(
        `UPDATE service_cancellations SET status = 'cancelled', admin_user_id = $2,
                admin_note = COALESCE(NULLIF($3, ''), admin_note),
                decided_at = now(), cancelled_at = now(), updated_at = now()
          WHERE id = $1`,
        [id, req.user.id, note || 'The service no longer existed when this was approved.']
      );
      await client.query('COMMIT');
      return res.json({ status: 'cancelled', message: 'That service no longer existed, so the request has been closed.' });
    }

    if (refund !== null && refund > 0) {
      // payment_id is set deliberately: account_credits_payment_once makes it
      // impossible to credit the same payment twice, so a service that was
      // already declined-with-credit cannot also be refunded here.
      try {
        await client.query(
          `INSERT INTO account_credits (user_id, amount, reason, note, payment_id, created_by)
           VALUES ($1, $2, 'cancelled_service', $3, $4, $5)`,
          [
            request.user_id, refund,
            `Cancellation of ${cfg.label}${request.reference ? ' (' + request.reference + ')' : ''}`,
            request.payment_id || null, req.user.id,
          ]
        );
      } catch (err) {
        if (err.code === '23505') {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: 'This payment has already been credited once (most likely declined with credit earlier). '
                 + 'Approve without a refund amount, or adjust the member\'s credit directly.',
          });
        }
        throw err;
      }
    }

    await client.query(
      `UPDATE service_cancellations
          SET status = 'cancelled', admin_user_id = $2,
              admin_note = COALESCE(NULLIF($3, ''), admin_note),
              refund_amount = $4, decided_at = now(), cancelled_at = now(), updated_at = now()
        WHERE id = $1`,
      [id, req.user.id, note, refund]
    );

    await client.query('COMMIT');

    await logActivity(req.user.id, 'cancellation_approved',
      `Approved cancellation #${id}: stopped ${cfg.label} #${request.service_id}`
      + `${request.reference ? ' (' + request.reference + ')' : ''}`
      + `${refund ? `, credited R${refund.toFixed(2)}` : ', no refund'}`
      + `${note ? '. Note: ' + note : ''}`).catch(() => {});

    res.json({
      status: 'cancelled',
      refundAmount: refund,
      message: refund
        ? `${cfg.label} stopped and R${refund.toFixed(2)} added to the member's account credit.`
        : `${cfg.label} stopped. No refund was issued.`,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// GET /cancellations/services — what the signed-in member currently has that
// could be cancelled. Without this the member has to know their own service
// type and row id, which is not a thing anyone knows.
router.get('/services', requireAuth, async (req, res, next) => {
  try {
    const out = [];
    for (const [type, cfg] of Object.entries(CANCELLABLE)) {
      const nameSelect = cfg.nameColumn ? `s.${cfg.nameColumn} AS label` : `NULL AS label`;
      // Only live services, and only ones with no open request already.
      const ownerCondition = cfg.ownerColumn
        ? `s.${cfg.ownerColumn} = $1`
        : `EXISTS (SELECT 1 FROM payments p WHERE p.linked_type IN (${cfg.paymentTypes.map((t) => `'${t}'`).join(', ')})
                    AND p.linked_id = s.id AND p.user_id = $1)`;
      const statusColumn = type === 'ad_banner' ? 'moderation_status' : 'status';
      const rows = await pool.query(
        `SELECT s.id, ${nameSelect}, s.created_at
           FROM ${cfg.table} s
          WHERE ${ownerCondition}
            AND s.${statusColumn} = 'approved'
            AND s.cancelled_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM service_cancellations c
               WHERE c.service_type = $2 AND c.service_id = s.id
                 AND c.status IN ('requested', 'under_review')
            )`,
        [req.user.id, type]
      ).catch(() => ({ rows: [] }));
      rows.rows.forEach((r) => out.push({
        serviceType: type, serviceTypeLabel: cfg.label,
        serviceId: r.id, label: r.label || cfg.label, submittedAt: r.created_at,
      }));
    }
    res.json({ services: out });
  } catch (err) {
    next(err);
  }
});

router.CANCELLABLE = CANCELLABLE;

module.exports = router;
