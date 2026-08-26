const express = require('express');
const pool = require('../db');
const { notifyAdminAsync, NOTIFY } = require('../utils/adminNotify');
const { requireRole } = require('../middleware/auth');
const { spamCheck } = require('../middleware/spamCheck');
const crm = require('../utils/crmCapture');
const { publicSubmitLimiter } = require('../middleware/rateLimit');
const honeypot = require('../middleware/honeypot');
const { EVENTS, trackAsync } = require('../utils/marketingEvents');

const router = express.Router();

// POST /inquiries — public. This is what the site's Contact form submits to.
router.post('/', publicSubmitLimiter, honeypot, spamCheck('contact enquiry'), async (req, res, next) => {
  try {
    const { name, email, subject, message } = req.body;
    if (!name || !email || !message) {
      return res.status(400).json({ error: 'name, email, and message are required.' });
    }
    // Only two kinds exist, and anything unrecognised is 'general'. An
    // advertising enquiry starts a five-email sales sequence, so this must
    // never be inferred from words somebody happened to type.
    const enquiryType = req.body.enquiryType === 'advertising' ? 'advertising' : 'general';

    const saved = await pool.query(
      `INSERT INTO inquiries (name, email, subject, message, enquiry_type)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [name, email, subject || null, message, enquiryType]
    );

    // Into the CRM: find or create the person, open a deal if this is a sales
    // enquiry, and put the message on their timeline.
    //
    // NOT AWAITED ON THE REPLY PATH — the person who filled in the form is
    // waiting, and filing their enquiry must never be the reason it feels
    // slow. captureSubmission never throws, so nothing here can turn a
    // received enquiry into an error message.
    crm.attributionFor(req.body.sessionId)
      .then((attribution) => crm.captureSubmission({
        email,
        fullName: name,
        formName: enquiryType === 'advertising' ? 'Advertising enquiry' : 'Contact form',
        message,
        // A general question is not a sale. Only an advertising enquiry opens
        // a deal, so the pipeline stays a list of things somebody can actually
        // close rather than every message ever received.
        shape: enquiryType === 'advertising' ? 'advertising' : null,
        attribution,
      }))
      .then((result) => {
        if (!result.contact) return;
        // The thread back to the original row, so the message lives in exactly
        // one place and the timeline points at it.
        return pool.query('UPDATE inquiries SET crm_contact_id = $2 WHERE id = $1',
          [saved.rows[0].id, result.contact.id]);
      })
      .catch((err) => console.error('[crm] enquiry capture failed:', err.message));

    // Each enquiry is its own row: a business asking about advertising is a
    // person waiting for a reply, not a statistic.
    notifyAdminAsync({
      type: NOTIFY.ENQUIRY,
      message: `New ${(enquiryType || 'general')} enquiry from ${name || 'someone'}`,
      detail: subject || null,
      link: 'inquiries',
    });
    if (enquiryType === 'advertising') {
      const firstName = String(name).trim().split(/[ ]+/)[0];
      trackAsync(EVENTS.ADVERTISER_ENQUIRED, {
        email, firstName,
        payload: { businessName: subject || '', source: 'advertise-page' },
      });
    }

    res.status(201).json({ message: 'Thanks — we\'ll get back to you soon.' });
  } catch (err) {
    next(err);
  }
});

// GET /inquiries — admin-only, newest first. (Mounted at /inquiries
// alongside the public POST above — different HTTP methods on the same
// path work fine side by side.)
router.get('/', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(`SELECT * FROM inquiries ORDER BY created_at DESC`);
    res.json({ inquiries: result.rows });
  } catch (err) {
    next(err);
  }
});

// PATCH /inquiries/:id/status — admin-only, mark as read or replied.
router.patch('/:id/status', requireRole('admin'), async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!['new', 'read', 'replied'].includes(status)) {
      return res.status(400).json({ error: 'status must be one of: new, read, replied.' });
    }
    const result = await pool.query(
      `UPDATE inquiries SET status = $1 WHERE id = $2 RETURNING *`,
      [status, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Inquiry not found.' });
    }
    res.json({ inquiry: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
