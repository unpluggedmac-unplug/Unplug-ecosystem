const express = require('express');
const pool = require('../db');
const { requireRole } = require('../middleware/auth');
const { packagesFor } = require('../utils/servicePackages');
const paymentsRouter = require('./payments');

const router = express.Router();

const SERVICE_CHECKS = [
  { type: 'profile_package', table: 'profiles', statusCol: 'status', awaiting: "status = 'awaiting_payment'", paidBad: "status = 'awaiting_payment'", label: 'Directory Package' },
  { type: 'competition_entry', table: 'competition_entries', statusCol: 'status', awaiting: "status = 'awaiting_payment'", paidBad: "status = 'awaiting_payment'", label: 'Competition Entry' },
  { type: 'highlight', table: 'highlights', statusCol: 'status', awaiting: "status = 'awaiting_payment'", paidBad: "status = 'awaiting_payment'", label: 'Highlight' },
  { type: 'marketplace_listing', table: 'marketplace_listings', statusCol: 'status', awaiting: "status = 'awaiting_payment'", paidBad: "status = 'awaiting_payment'", label: 'Marketplace Poster' },
  { type: 'article_publish', table: 'articles', statusCol: 'status', awaiting: "status = 'awaiting_payment'", paidBad: "status = 'awaiting_payment'", label: 'Article Submission' },
  { type: 'event_listing', table: 'events', statusCol: 'status', awaiting: "status = 'awaiting_payment'", paidBad: "status = 'awaiting_payment'", label: 'Event Listing' },
  { type: 'gallery_bundle', table: 'gallery_bundles', statusCol: 'status', awaiting: "status = 'awaiting_payment'", paidBad: "status = 'awaiting_payment'", label: 'Gallery Bundle' },
  { type: 'top10_entry', table: 'top10_entries', statusCol: 'status', awaiting: "status = 'awaiting_payment'", paidBad: "status = 'awaiting_payment'", label: 'Top 10 Entry' },
  { type: 'ad_banner', table: 'ad_slots', statusCol: 'moderation_status', awaiting: "moderation_status = 'pending_payment'", paidBad: "moderation_status = 'pending_payment'", label: 'Page Banner' },
];

async function serviceAnomalies() {
  const rows = [];
  for (const c of SERVICE_CHECKS) {
    const q = await pool.query(
      `SELECT s.id, s.${c.statusCol} AS service_status, s.created_at,
              EXISTS (SELECT 1 FROM payments p WHERE p.linked_type = $1 AND p.linked_id = s.id AND p.status IN ('pending','confirmed')) AS has_payment,
              EXISTS (SELECT 1 FROM payments p WHERE p.linked_type = $1 AND p.linked_id = s.id AND p.status = 'confirmed') AS has_confirmed_payment
         FROM ${c.table} s
        WHERE (${c.awaiting})
        ORDER BY s.created_at ASC
        LIMIT 100`, [c.type]
    );
    for (const r of q.rows) {
      if (!r.has_payment || r.has_confirmed_payment) {
        rows.push({
          linkedType: c.type, service: c.label, linkedId: r.id,
          status: r.service_status, createdAt: r.created_at,
          issue: r.has_confirmed_payment ? 'confirmed_payment_but_service_still_awaiting' : 'awaiting_payment_without_payment',
        });
      }
    }
  }
  return rows;
}

router.get('/', requireRole('admin'), async (_req, res, next) => {
  try {
    const [pendingPayments, pendingOrders, failedFulfilments, anomalies, adPackages, highlightArticle, highlightDirectory] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS count, COALESCE(SUM(amount),0)::numeric AS amount,
                         COUNT(*) FILTER (WHERE created_at < now() - interval '7 days')::int AS older_than_7_days
                    FROM payments WHERE status = 'pending'`),
      pool.query(`SELECT COUNT(*)::int AS count, COALESCE(SUM(total),0)::numeric AS amount,
                         COUNT(*) FILTER (WHERE created_at < now() - interval '7 days')::int AS older_than_7_days
                    FROM orders WHERE status = 'pending'`),
      pool.query(`SELECT id, linked_type, linked_id, amount, gateway_reference, fulfillment_error, confirmed_at
                    FROM payments
                   WHERE status = 'confirmed' AND fulfillment_status = 'failed'
                   ORDER BY confirmed_at ASC NULLS FIRST LIMIT 100`),
      serviceAnomalies(),
      packagesFor('ad_banner'), packagesFor('highlight_article'), packagesFor('highlight_directory'),
    ]);

    const gatewayIsLive = paymentsRouter.gatewayIsLive || (() => false);
    res.json({
      checkedAt: new Date().toISOString(),
      gateways: {
        eft: { live: true, label: 'Manual EFT' },
        payfast: { live: gatewayIsLive('payfast'), label: 'PayFast' },
        ozow: { live: gatewayIsLive('ozow'), label: 'Ozow' },
      },
      pending: {
        payments: { count: pendingPayments.rows[0].count, amount: Number(pendingPayments.rows[0].amount), olderThan7Days: pendingPayments.rows[0].older_than_7_days },
        orders: { count: pendingOrders.rows[0].count, amount: Number(pendingOrders.rows[0].amount), olderThan7Days: pendingOrders.rows[0].older_than_7_days },
      },
      anomalies,
      failedFulfilments: failedFulfilments.rows,
      packages: {
        adBanner: adPackages,
        highlightArticle,
        highlightDirectory,
      },
    });
  } catch (err) { next(err); }
});


router.post('/payments/:id/retry-fulfilment', requireRole('admin'), async (req, res, next) => {
  try {
    const found = await pool.query('SELECT * FROM payments WHERE id = $1', [req.params.id]);
    if (!found.rowCount) return res.status(404).json({ error: 'Payment not found.' });
    const payment = found.rows[0];
    if (payment.status !== 'confirmed') return res.status(400).json({ error: 'Only a confirmed payment can have its service fulfilment retried.' });
    try {
      await paymentsRouter.applyPaymentEffectTracked(payment);
    } catch (err) {
      return res.status(409).json({ error: `Fulfilment failed again: ${err.message}` });
    }
    res.json({ ok: true, message: 'Service fulfilment applied successfully.' });
  } catch (err) { next(err); }
});

module.exports = router;
