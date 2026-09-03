// My Submissions, and every "My X" section that is a filter on it.
//
// Deliberately thin. The shape, the ownership and the status wording all live
// in utils/mySubmissions.js so that the six menu items §4 asks for cannot drift
// apart — this file only decides who is asking and hands back what it is given.

const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const {
  listFor, isType, TYPES, SUBMISSION_TYPES, SERVICE_TYPES,
  groupServices, EXPIRING_WITHIN_DAYS,
} = require('../utils/mySubmissions');
const invoices = require('../utils/invoices');
const myVotes = require('../utils/myVotes');
const notifPrefs = require('../utils/notificationPreferences');
const { generateDocument } = require('../utils/pdfDocs');

// GET /my/submissions          — everything this member has submitted
// GET /my/submissions?type=... — one menu item (My Articles, My Events, …)
//
// Always the logged-in member: there is no user parameter, so there is nothing
// to tamper with. An unknown ?type is refused rather than quietly ignored — a
// filter that stops filtering shows a member the wrong list while looking like
// it worked.
router.get('/submissions', requireAuth, async (req, res, next) => {
  try {
    const type = req.query.type ? String(req.query.type) : null;
    if (type && (!isType(type) || SUBMISSION_TYPES.indexOf(type) === -1)) {
      return res.status(400).json({
        error: 'Unknown submission type.',
        known: SUBMISSION_TYPES,
      });
    }

    const submissions = await listFor(req.user.id, { only: SUBMISSION_TYPES, type });
    res.json({ submissions });
  } catch (err) {
    next(err);
  }
});

// GET /my/services — the same data, read as §5 asks for it: active, pending,
// expiring, expired, requiring changes, awaiting payment.
//
// Competitions are excluded: an entry is not bought for a period and cannot be
// renewed — it ends when the competition closes, which is the competition's
// business. They stay in My Submissions.
router.get('/services', requireAuth, async (req, res, next) => {
  try {
    // TODAY COMES FROM THE DATABASE, not from Node. Whether a service has
    // expired is a question about the same clock that stored its dates, and
    // working it out here instead is a second clock that disagrees whenever the
    // server's local date is ahead of UTC.
    const now = await pool.query(`SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS today`);
    const today = now.rows[0].today;

    const services = await listFor(req.user.id, { only: SERVICE_TYPES });
    res.json({
      today,
      expiringWithinDays: EXPIRING_WITHIN_DAYS,
      groups: groupServices(services, today),
    });
  } catch (err) {
    next(err);
  }
});

// GET /my/invoices — §10.5. The member's own invoices, newest first.
router.get('/invoices', requireAuth, async (req, res, next) => {
  try {
    res.json({ invoices: await invoices.listFor(req.user.id) });
  } catch (err) {
    next(err);
  }
});

// GET /my/invoices/:id — one invoice with its lines.
router.get('/invoices/:id', requireAuth, async (req, res, next) => {
  try {
    const invoice = await invoices.getForMember(req.user.id, req.params.id);
    // 404 rather than 403 for someone else's: whether an invoice number exists
    // is not something to confirm to a person who does not own it.
    if (!invoice) return res.status(404).json({ error: 'Invoice not found.' });
    res.json({ invoice });
  } catch (err) {
    next(err);
  }
});

// GET /my/invoices/:id/pdf — the document itself.
//
// Generated on request and streamed, NOT stored. It is rendered from the
// invoice row, so it always matches the record; a stored file would be a second
// copy that could fall out of step with it. It also means this works without
// file storage configured, which the admin-side generator needs.
router.get('/invoices/:id/pdf', requireAuth, async (req, res, next) => {
  try {
    const invoice = await invoices.getForMember(req.user.id, req.params.id);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found.' });

    const buffer = await generateDocument({
      kind: 'invoice',
      invoiceNumber: invoice.invoice_number,
      reference: invoice.reference,
      customerName: req.user.full_name || req.user.email,
      customerEmail: req.user.email,
      items: invoice.items,
      subtotal: invoice.subtotal,
      voucherDiscount: invoice.voucher_discount,
      creditUsed: invoice.credit_used,
      total: invoice.total,
      method: invoice.method,
      status: invoice.status,
      date: new Date(invoice.issued_at).toLocaleDateString('en-ZA'),
      vatNumber: invoice.vatNumber,
      vatRate: invoice.vatRate,
      vatAmount: invoice.vatAmount,
      netAmount: invoice.netAmount,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      `inline; filename="${invoice.invoice_number}.pdf"`);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

// GET /my/votes — §4's "My Votes / Competition Activity".
//
// Only what is genuinely this member's: §9.1 makes online voting account-free,
// so anonymous votes stay anonymous rather than being guessed at from a session.
router.get('/votes', requireAuth, async (req, res, next) => {
  try {
    res.json(await myVotes.activityFor(req.user.id));
  } catch (err) {
    next(err);
  }
});

// Account Settings (§4) — notification preferences.
//
// The table has been read since the notifications work shipped, deciding
// whether to email somebody. Nothing ever wrote to it, so a member could be
// emailed with no way to stop it. These two are that missing half.
//
// The FIELDS are sent with the values so the screen does not keep its own copy
// of what each switch means.
router.get('/notification-preferences', requireAuth, async (req, res, next) => {
  try {
    res.json({
      preferences: await notifPrefs.getFor(req.user.id),
      fields: notifPrefs.FIELDS.map((f) => ({ key: f.key, label: f.label, help: f.help })),
    });
  } catch (err) {
    next(err);
  }
});

router.patch('/notification-preferences', requireAuth, async (req, res, next) => {
  try {
    const preferences = await notifPrefs.updateFor(req.user.id, req.body || {});
    res.json({ preferences });
  } catch (err) {
    next(err);
  }
});

// GET /my/submission-types — what the menu can offer.
//
// The dashboard builds its own sections from this rather than repeating the
// list in HTML, so adding a service in one place adds it everywhere.
router.get('/submission-types', requireAuth, (req, res) => {
  res.json({
    types: SUBMISSION_TYPES.map((key) => ({
      type: key,
      label: TYPES[key].label,
      plural: TYPES[key].plural,
    })),
  });
});

module.exports = router;
