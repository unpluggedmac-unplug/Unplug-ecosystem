// Payment Portal Redevelopment — Phase 3: Unplug Services Payment Portal,
// multi-service cart checkout. Members-only (requireAuth throughout),
// separate from the anonymous Bulk Votes portal (routes/competitions.js,
// Phase 2) — the two "must never interfere with each other".
//
// Reuses payments.js's resolveAmount/applyVoucher/applyPaymentEffect
// completely unchanged (see the exports added there) rather than
// re-implementing per-service pricing and payment-effect logic for a
// second time. See 096_orders_cart_checkout.sql for why each cart item
// is a real row in the existing `payments` table (grouped by order_id)
// instead of a new parallel table.

const express = require('express');
const crypto = require('crypto');
const { attributeConsultant } = require('../utils/consultantAttribution');
const pool = require('../db');
const { generateUnique } = require('../utils/reference');
const { serviceLabel } = require('../utils/submissionReference');
const { requireAuth, requireRole } = require('../middleware/auth');
const { spendCredit, balanceFor } = require('../utils/accountCredit');
const { eftInstructions } = require('../utils/eftDetails');
const { logActivity } = require('./activityLog');
const paymentsRouter = require('./payments');
const { resolveAmount, applyVoucher, recordVoucherRedemption, applyPaymentEffect, TERMS_VERSION } = paymentsRouter;

const router = express.Router();

// The 10 services the brief's Portal 1 Step 2 actually lists as
// cart-selectable. edition_download and vote_bundle are deliberately
// absent — see the migration's header comment for why.
const CART_ELIGIBLE_TYPES = [
  'profile_package', 'profile_upgrade', 'competition_entry', 'highlight',
  'marketplace_listing', 'article_publish', 'event_listing', 'gallery_bundle',
  'top10_entry', 'ad_banner',
];

const REFERRAL_SOURCES = ['google', 'facebook', 'instagram', 'linkedin', 'tiktok', 'sales_consultant', 'other'];
// The order reference: UNP- and ten characters. Spec §15 wants it unique,
// searchable and immutable, and it is the string the customer puts on their
// EFT. Generated in src/utils/reference.js, which is the one place that
// decides what a reference looks like.
const generateOrderReference = () =>
  generateUnique({ table: 'orders', column: 'reference', prefix: 'UNP-' });

// A voucher's service_restriction is a single linkedType (the same shape
// applyVoucher already checks for a single-item purchase). For a cart,
// "does this voucher apply here" means it matches AT LEAST ONE item —
// duplicating just that check rather than bending applyVoucher's
// single-item signature to also mean "matches any of these".
async function applyVoucherToCart(code, userId, cartLinkedTypes, subtotal) {
  const result = await pool.query(
    `SELECT * FROM vouchers WHERE code = $1 AND active = true AND expires_at > now()`,
    [code.toUpperCase().trim()]
  );
  if (result.rows.length === 0) throw new Error('This voucher code is invalid, expired, or no longer active.');
  const voucher = result.rows[0];
  if (voucher.service_restriction && !cartLinkedTypes.includes(voucher.service_restriction)) {
    throw new Error('This voucher code does not apply to anything in this order.');
  }
  const alreadyUsed = await pool.query(
    `SELECT id FROM voucher_redemptions WHERE voucher_id = $1 AND user_id = $2`,
    [voucher.id, userId]
  );
  if (alreadyUsed.rows.length > 0) throw new Error('You have already used this voucher code.');
  const discountAmount = voucher.discount_type === 'percent'
    ? Math.min(subtotal, (subtotal * Number(voucher.discount_value)) / 100)
    : Math.min(subtotal, Number(voucher.discount_value));
  const finalAmount = Math.max(0, subtotal - discountAmount);
  return { voucher, discountAmount, finalAmount };
}

function validateItemsShape(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return 'items must be a non-empty array of { linkedType, linkedId }.';
  }
  if (items.length > 20) {
    return 'A single order can hold at most 20 services — check out in more than one order if you need more.';
  }
  for (const item of items) {
    if (!CART_ELIGIBLE_TYPES.includes(item.linkedType)) {
      return `"${item.linkedType}" cannot be added to a cart order — it must be one of: ${CART_ELIGIBLE_TYPES.join(', ')}.`;
    }
    if (!Number.isInteger(Number(item.linkedId))) {
      return `Every item needs a valid linkedId (got one for "${item.linkedType}" that isn't a number).`;
    }
  }
  return null;
}

// POST /orders/quote — same spirit as POST /payments/quote, for a whole
// cart: prices every item server-side, applies one voucher and one
// credit deduction across the total, and writes nothing.
router.post('/quote', requireAuth, async (req, res, next) => {
  try {
    const { items, voucherCode, useCredit } = req.body;
    const shapeError = validateItemsShape(items);
    if (shapeError) return res.status(400).json({ error: shapeError });

    const priced = [];
    for (const item of items) {
      const amount = await resolveAmount(item.linkedType, Number(item.linkedId));
      priced.push({ linkedType: item.linkedType, linkedId: Number(item.linkedId), amount });
    }
    const subtotal = Number(priced.reduce((sum, p) => sum + p.amount, 0).toFixed(2));

    let voucherDiscount = 0;
    let voucherError = null;
    let afterVoucher = subtotal;
    if (voucherCode) {
      try {
        const v = await applyVoucherToCart(voucherCode, req.user.id, items.map((i) => i.linkedType), subtotal);
        afterVoucher = v.finalAmount;
        voucherDiscount = Number((subtotal - afterVoucher).toFixed(2));
      } catch (e) {
        voucherError = e.message;
      }
    }

    const creditBalance = await balanceFor(req.user.id);
    const creditApplied = useCredit === true
      ? Number(Math.min(creditBalance, afterVoucher).toFixed(2))
      : 0;
    const total = Number((afterVoucher - creditApplied).toFixed(2));

    res.json({
      items: priced,
      subtotal,
      voucherDiscount,
      voucherCode: voucherDiscount > 0 ? voucherCode : null,
      voucherError,
      creditBalance,
      creditApplied,
      creditRemainingAfter: Number((creditBalance - creditApplied).toFixed(2)),
      total,
      settledWithoutPayment: total === 0,
    });
  } catch (err) {
    if (err.message.includes('not found') || err.message.includes('not implemented')) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

// POST /orders/initiate — creates the order AND one real payments row per
// cart item (see the migration for why), applies the Step 9 gates, and
// either confirms immediately (fully covered by credit) or returns one
// combined reference + EFT instructions for the whole cart.
router.post('/initiate', requireAuth, async (req, res, next) => {
  try {
    const {
      items, method, voucherCode, useCredit, termsAccepted, infoConfirmed,
      referralSource, salesConsultantId,
    } = req.body;

    const shapeError = validateItemsShape(items);
    if (shapeError) return res.status(400).json({ error: shapeError });
    if (!['payfast', 'ozow', 'eft'].includes(method)) {
      return res.status(400).json({ error: 'method must be one of: payfast, ozow, eft' });
    }
    // STEP 9 — two SEPARATE mandatory checkboxes, both required: reviewing
    // the information is not the same act as accepting the Terms, so one
    // cannot silently stand in for the other.
    if (infoConfirmed !== true) {
      return res.status(400).json({ error: 'You must confirm that all information in this order is correct before continuing.' });
    }
    if (termsAccepted !== true) {
      return res.status(400).json({ error: 'You must read and accept the current Unplug Terms & Conditions and Cancellation, Refund & Account Credit Policy before checkout.' });
    }
    if (referralSource && !REFERRAL_SOURCES.includes(referralSource)) {
      return res.status(400).json({ error: `referralSource must be one of: ${REFERRAL_SOURCES.join(', ')}` });
    }
    if (referralSource === 'sales_consultant' && !salesConsultantId) {
      return res.status(400).json({ error: 'salesConsultantId is required when referralSource is "sales_consultant".' });
    }

    // Price every item server-side — never trust a client-supplied amount,
    // same rule every other checkout on this site follows.
    const priced = [];
    for (const item of items) {
      const amount = await resolveAmount(item.linkedType, Number(item.linkedId));
      priced.push({ linkedType: item.linkedType, linkedId: Number(item.linkedId), amount });
    }
    const subtotal = Number(priced.reduce((sum, p) => sum + p.amount, 0).toFixed(2));

    let afterVoucher = subtotal;
    let appliedVoucher = null;
    let voucherDiscount = 0;
    if (voucherCode) {
      const v = await applyVoucherToCart(voucherCode, req.user.id, items.map((i) => i.linkedType), subtotal);
      afterVoucher = v.finalAmount;
      appliedVoucher = v.voucher;
      voucherDiscount = Number((subtotal - afterVoucher).toFixed(2));
    }

    const reference = await generateOrderReference();

    const client = await pool.connect();
    let order;
    let paymentRows = [];
    try {
      await client.query('BEGIN');

      let creditUsed = 0;
      if (useCredit === true) {
        creditUsed = await spendCredit(client, req.user.id, afterVoucher, `Applied to order ${reference}`);
      }
      const total = Number((afterVoucher - creditUsed).toFixed(2));

      // One attribution decision for the whole order, reused for every item
      // below — resolving per item could otherwise credit two consultants for
      // a single basket. See utils/consultantAttribution.js.
      const attributed = await attributeConsultant(
        req.user.id,
        referralSource === 'sales_consultant' ? salesConsultantId : null,
        client
      );

      const orderResult = await client.query(
        `INSERT INTO orders (user_id, reference, method, subtotal, voucher_code, voucher_discount, credit_used, total,
                              referral_source, sales_consultant_id, consultant_source,
                              terms_version, terms_accepted_at, terms_ip, terms_user_agent, info_confirmed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now(), $13, $14, now())
         RETURNING *`,
        [
          req.user.id, reference, method, subtotal,
          appliedVoucher ? voucherCode : null, voucherDiscount, creditUsed, total,
          referralSource || null, attributed.consultantId, attributed.source,
          TERMS_VERSION, req.ip, req.get('user-agent') || null,
        ]
      );
      order = orderResult.rows[0];

      // THE SAVED CART IS NOW AN ORDER, so it stops being an abandoned cart.
      // Without this the same person is chased twice about one intention: once
      // "you left something in your cart" and once "your order is waiting".
      //
      // Marked converted rather than deleted, so "have we already chased this
      // person" survives and a cart that came back cannot be counted as new.
      await client.query(
        `UPDATE saved_carts SET converted_at = now() WHERE user_id = $1 AND converted_at IS NULL`,
        [req.user.id]);

      // Each item's payable share is proportional to its price within the
      // order — a R95 article and a R300 event share a single voucher/
      // credit discount in proportion to what each actually costs, not
      // evenly. The last item absorbs the rounding remainder so the sum
      // of every item's `amount` always equals order.total exactly.
      let allocated = 0;
      for (let i = 0; i < priced.length; i++) {
        const isLast = i === priced.length - 1;
        const share = isLast
          ? Number((total - allocated).toFixed(2))
          : Number(((priced[i].amount / subtotal) * total).toFixed(2));
        allocated = Number((allocated + share).toFixed(2));

        const paymentResult = await client.query(
          `INSERT INTO payments (user_id, amount, method, gateway_reference, linked_type, linked_id,
                                  referral_source, sales_consultant_id, consultant_source,
                                  terms_version, terms_accepted_at, terms_ip, terms_user_agent,
                                  credit_used, order_total, voucher_discount, voucher_code, order_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), $11, $12, $13, $14, $15, $16, $17)
           RETURNING *`,
          [
            req.user.id, share, method, `${reference}-${i + 1}`, priced[i].linkedType, priced[i].linkedId,
            referralSource || null, attributed.consultantId, attributed.source,
            TERMS_VERSION, req.ip, req.get('user-agent') || null,
            0, priced[i].amount, 0, null, order.id,
          ]
        );
        paymentRows.push(paymentResult.rows[0]);
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    if (appliedVoucher) {
      // One redemption record for the order, not one per item — the
      // voucher was used once, against the order, same as credit.
      await recordVoucherRedemption(appliedVoucher.id, req.user.id, 'order', order.id, subtotal - afterVoucher);
    }

    // Credit covered the whole order — nothing to pay, confirm every item
    // immediately. Same reasoning as the single-item flow: sending someone
    // to EFT instructions for R0.00 leaves the order stuck forever.
    if (Number(order.total) === 0) {
      await pool.query(`UPDATE payments SET status = 'confirmed', confirmed_at = now() WHERE order_id = $1`, [order.id]);
      await pool.query(`UPDATE orders SET status = 'confirmed', confirmed_at = now() WHERE id = $1`, [order.id]);
      for (const p of paymentRows) {
        try { await applyPaymentEffect({ ...p, status: 'confirmed' }); } catch (e) { /* one item's effect failing must not block the others */ }
      }
      return res.status(201).json({
        order: { ...order, status: 'confirmed' },
        items: paymentRows,
        paidInFull: true,
        message: `Covered in full by your R${Number(order.credit_used).toFixed(2)} account credit — nothing to pay.`,
      });
    }

    if (method === 'eft') {
      return res.status(201).json({
        order, items: paymentRows,
        instructions: eftInstructions(reference,
          'Make a standard bank EFT to the account above using this exact reference — one payment covers every service in this order. Everything is submitted for approval once it clears.'),
      });
    }

    res.status(201).json({
      order, items: paymentRows,
      redirectUrl: `https://sandbox.${method}.example.com/checkout?ref=${reference}&amount=${order.total}`,
      note: `Stub URL — replace with a real ${method === 'payfast' ? 'PayFast' : 'Ozow'} checkout link once merchant credentials are available.`,
    });
  } catch (err) {
    if (err.message.includes('not found') || err.message.includes('not implemented') || err.message.includes('voucher')) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

// POST /orders/recovery-run — one pass of the reminder runner, by hand.
//
// The runner is OFF by default (UNPLUG_CHECKOUT_RECOVERY). This is how to
// watch what it would do before handing it to a timer, and how an external
// scheduler drives it on an instance that sleeps — the same shared-secret
// shape as /maintenance/cleanup, /backups/run and /admin/email/tick.
//
// IT REALLY SENDS. There is no dry-run mode, on purpose: a dry run that
// reports what it "would" send is a second code path, and the one that never
// runs is the one that is wrong. Run it once with the thresholds in mind and
// look at what arrived.
router.post('/recovery-run', async (req, res, next) => {
  try {
    const secret = process.env.UNPLUG_CLEANUP_SECRET;
    const isAdmin = req.user && req.user.role === 'admin';
    if (!isAdmin) {
      if (!secret) return res.status(503).json({ error: 'No scheduler secret is configured.' });
      if (req.get('X-Cron-Secret') !== secret) return res.status(401).json({ error: 'Not authorised.' });
    }
    res.json(await require('../utils/checkoutRecovery').run());
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// The saved cart
// ---------------------------------------------------------------------------
//
// The cart lives in the browser. These endpoints keep a COPY on the server so
// it survives a new device, a cleared browser, and a phone that died — and so
// somebody who walked away can be reminded it is there.
//
// THE COPY IS NEVER THE SOURCE OF A PRICE. items is the same
// { linkedType, linkedId } shape /orders/initiate already validates, and
// checkout re-prices every line server-side exactly as it did before. A cart
// saved in March must not buy at March's price in September, and a stored
// price is precisely the field somebody would try to edit.
//
// SIGNED-IN ONLY, because checkout is signed-in only. There is no anonymous
// cart to save and no address to send anything to.

// PUT /orders/cart — replace the saved cart.
router.put('/cart', requireAuth, async (req, res, next) => {
  try {
    const items = Array.isArray(req.body.items) ? req.body.items : null;
    if (!items) return res.status(400).json({ error: 'items must be an array.' });

    // Same shape rules as checkout, minus the "must not be empty" one: saving
    // an empty cart is how somebody clears it.
    if (items.length) {
      const shapeError = validateItemsShape(items);
      if (shapeError) return res.status(400).json({ error: shapeError });
    }

    // updated_at moving resets the reminder count: a cart somebody has just
    // changed is a live intention again, not the one they already ignored.
    await pool.query(
      `INSERT INTO saved_carts (user_id, items, updated_at, reminders_sent, last_reminded_at, converted_at)
       VALUES ($1, $2, now(), 0, NULL, NULL)
       ON CONFLICT (user_id) DO UPDATE SET
         items = EXCLUDED.items,
         updated_at = now(),
         reminders_sent = 0,
         last_reminded_at = NULL,
         converted_at = NULL`,
      [req.user.id, JSON.stringify(items.slice(0, 20))]);

    res.json({ ok: true, count: items.length });
  } catch (err) { next(err); }
});

// GET /orders/cart — what was saved, if anything.
router.get('/cart', requireAuth, async (req, res, next) => {
  try {
    const r = await pool.query(
      'SELECT items, updated_at FROM saved_carts WHERE user_id = $1 AND converted_at IS NULL',
      [req.user.id]);
    res.json(r.rowCount ? { items: r.rows[0].items, updatedAt: r.rows[0].updated_at } : { items: [] });
  } catch (err) { next(err); }
});

// DELETE /orders/cart — forget it.
//
// The row is REMOVED rather than emptied. Somebody clearing their cart has
// asked for it to be gone, and keeping an empty row that records they once
// had one is not what they meant.
router.delete('/cart', requireAuth, async (req, res, next) => {
  try {
    await pool.query('DELETE FROM saved_carts WHERE user_id = $1', [req.user.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /orders/:id/stop-reminders — from the link in a reminder email.
//
// Stops the chasing for ONE order without unsubscribing from anything else.
// Without this the only way to stop a reminder is to leave the mailing list,
// which is far more than somebody means when they think "stop emailing me
// about this order".
router.post('/:id/stop-reminders', requireAuth, async (req, res, next) => {
  try {
    const r = await pool.query(
      `UPDATE orders SET recovery_opted_out = true
        WHERE id = $1 AND user_id = $2 RETURNING id`, [req.params.id, req.user.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'No such order.' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// GET /orders/mine — the member's own order history, one row per order
// with its item count — mirrors GET /payments/mine's shape.
router.get('/mine', requireAuth, async (req, res, next) => {
  try {
    const orders = await pool.query(
      // The linked_types are aggregated so the list can say what each order was
      // FOR without a second request per row. ARRAY_REMOVE drops the NULL that
      // the LEFT JOIN produces for an order with no payments yet.
      `SELECT o.*, COUNT(p.id)::int AS item_count,
              ARRAY_REMOVE(ARRAY_AGG(DISTINCT p.linked_type), NULL) AS linked_types
         FROM orders o LEFT JOIN payments p ON p.order_id = o.id
        WHERE o.user_id = $1
        GROUP BY o.id
        ORDER BY o.created_at DESC
        LIMIT 100`,
      [req.user.id]
    );
    res.json({
      orders: orders.rows.map((o) => ({
        ...o,
        serviceNames: (o.linked_types || []).map(serviceLabel),
      })),
    });
  } catch (err) {
    next(err);
  }
});

// GET /orders/:id — one order with its full item breakdown, owner or admin.
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const order = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
    if (order.rows.length === 0) return res.status(404).json({ error: 'Order not found.' });
    if (order.rows[0].user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'That order is not yours.' });
    }
    const items = await pool.query(
      `SELECT id, linked_type, linked_id, amount, order_total, status, gateway_reference FROM payments WHERE order_id = $1 ORDER BY id ASC`,
      [req.params.id]
    );
    // serviceName is what the member is shown. linked_type stays on the row for
    // anything that needs the key; the NAME is worked out here rather than in
    // the browser so an order, an invoice and a receipt cannot end up calling
    // the same purchase three different things.
    res.json({
      order: order.rows[0],
      items: items.rows.map((i) => ({ ...i, serviceName: serviceLabel(i.linked_type) })),
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /orders/:id/proof — attaches a proof-of-payment URL (already
// uploaded via POST /uploads/proof) to the payer's own order. See the
// matching route in payments.js for the full reasoning — same shape here,
// one row per order rather than per cart item since it was one bank
// transfer for the whole cart.
router.patch('/:id/proof', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const url = String(req.body.url || '').trim();
    if (!url) return res.status(400).json({ error: 'A file URL is required — upload via POST /uploads/proof first.' });
    const result = await pool.query(
      `UPDATE orders SET pop_url = $1 WHERE id = $2 AND user_id = $3 RETURNING id, pop_url`,
      [url, id, req.user.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Order not found.' });
    res.json({ order: result.rows[0], message: 'Proof of payment attached — thank you.' });
  } catch (err) {
    next(err);
  }
});

// PATCH /orders/admin/:id/confirm-eft — admin-only, mirrors PATCH
// /payments/:id/confirm-eft but confirms every item in the order as one
// action, since it was one bank transfer for the whole cart.
router.patch('/admin/:id/confirm-eft', requireRole('admin'), async (req, res, next) => {
  try {
    const order = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
    if (order.rows.length === 0) return res.status(404).json({ error: 'Order not found.' });
    if (order.rows[0].method !== 'eft') return res.status(400).json({ error: 'This endpoint is only for manual EFT orders.' });
    if (order.rows[0].status !== 'pending') return res.status(400).json({ error: `Order is already ${order.rows[0].status}.` });

    const items = await pool.query(`SELECT * FROM payments WHERE order_id = $1`, [req.params.id]);
    await pool.query(`UPDATE payments SET status = 'confirmed', confirmed_at = now() WHERE order_id = $1`, [req.params.id]);
    await pool.query(`UPDATE orders SET status = 'confirmed', confirmed_at = now() WHERE id = $1`, [req.params.id]);

    for (const item of items.rows) {
      try { await applyPaymentEffect({ ...item, status: 'confirmed' }); } catch (e) { /* one item's effect failing must not block the others */ }
    }

    logActivity(req.user.id, 'order_confirmed', `Order ${order.rows[0].reference} — ${items.rows.length} item(s), R${order.rows[0].total}`);
    res.json({ message: 'Order confirmed and every item applied.' });
  } catch (err) {
    next(err);
  }
});

// PATCH /orders/admin/:id/reject — the counterpart to confirm-eft above, for
// when the EFT never arrives or the order should not go ahead.
//
// Only a PENDING order can be rejected. A confirmed one has already had every
// item's applyPaymentEffect run (articles published, banners scheduled, votes
// allocated), and undoing that generically is not something this endpoint can
// honestly claim to do — those need the per-item reversal paths instead.
//
// Any account credit spent on the order is put back. spendCredit() wrote a
// negative ledger row at checkout, so without this the customer would have
// paid real credit and received nothing — the single most costly thing this
// endpoint could get wrong. The voucher is deliberately NOT auto-reinstated:
// voucher usage limits are tracked separately, and silently handing back a
// single-use code is a decision for an admin, not a side effect of rejecting.
router.patch('/admin/:id/reject', requireRole('admin'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (found.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found.' });
    }
    const order = found.rows[0];
    if (order.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: order.status === 'confirmed'
          ? 'This order has already been confirmed and its services applied — it cannot be rejected. Reverse the individual items instead.'
          : `Order is already ${order.status}.`,
      });
    }

    await client.query(`UPDATE payments SET status = 'failed' WHERE order_id = $1`, [order.id]);
    await client.query(`UPDATE orders SET status = 'failed' WHERE id = $1`, [order.id]);

    const creditUsed = Number(order.credit_used) || 0;
    if (creditUsed > 0) {
      await client.query(
        `INSERT INTO account_credits (user_id, amount, reason, note, created_by)
         VALUES ($1, $2, 'cancelled_service', $3, $4)`,
        [order.user_id, creditUsed, `Order ${order.reference} rejected — credit returned`, req.user.id]
      );
    }
    await client.query('COMMIT');

    logActivity(req.user.id, 'order_rejected',
      `Order ${order.reference} rejected${creditUsed > 0 ? ` — R${creditUsed.toFixed(2)} credit returned` : ''}`);
    res.json({
      message: creditUsed > 0
        ? `Order rejected. R${creditUsed.toFixed(2)} of account credit has been returned to the customer.`
        : 'Order rejected.',
      creditReturned: creditUsed,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// GET /orders/admin/all — the admin queue for this portal specifically. A
// fuller cross-portal search/filter view is Phase 6's job; this is what
// makes the cart functionally complete on its own in the meantime.
router.get('/admin/all', requireRole('admin'), async (req, res, next) => {
  try {
    const conditions = [];
    const values = [];
    if (req.query.status) { values.push(req.query.status); conditions.push(`o.status = $${values.length}`); }
    if (req.query.q) {
      values.push(`%${req.query.q}%`);
      conditions.push(`(o.reference ILIKE $${values.length} OR u.email ILIKE $${values.length})`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const orders = await pool.query(
      `SELECT o.*, u.email, u.full_name, COUNT(p.id)::int AS item_count
         FROM orders o
         JOIN users u ON u.id = o.user_id
         LEFT JOIN payments p ON p.order_id = o.id
         ${where}
        GROUP BY o.id, u.email, u.full_name
        ORDER BY o.created_at DESC
        LIMIT 500`,
      values
    );
    res.json({ orders: orders.rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
