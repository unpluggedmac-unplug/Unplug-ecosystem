const express = require('express');
const { recordConversionAsync } = require('../utils/analyticsRecorder');
const { EVENTS, trackAsync } = require('../utils/marketingEvents');
const pool = require('../db');
const { requireRole } = require('../middleware/auth');
const { spamCheck } = require('../middleware/spamCheck');
const { publicSubmitLimiter } = require('../middleware/rateLimit');
const honeypot = require('../middleware/honeypot');
const marketing = require('../utils/emailMarketing');
const requestContext = require('../middleware/requestContext');

const router = express.Router();

// POST /newsletter/subscribe — public. Stores the email; duplicate signups
// are silently ignored (ON CONFLICT), so re-subscribing is harmless.
router.post('/subscribe', publicSubmitLimiter, honeypot, spamCheck('newsletter signup'), async (req, res, next) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'A valid email address is required.' });
    }
    await pool.query(
      `INSERT INTO newsletter_subscribers (email) VALUES ($1) ON CONFLICT (email) DO NOTHING`,
      [email]
    );

    // AND INTO THE CONSENT SYSTEM, which is where subscribers actually live now.
    //
    // This route wrote only to newsletter_subscribers. Migration 141 imported
    // the people who existed the day it ran, but every signup after that kept
    // landing in the old table alone — so they were on no mailing list, had no
    // record of where their consent came from, and a campaign sent to "The
    // Friday newsletter" reached none of them. The gap widened by one person
    // per signup, invisibly, and the first symptom would have been a newsletter
    // that mysteriously went to fewer people than had subscribed to it.
    //
    // BOTH WRITES ARE KEPT. The old table is read by the analytics dashboard
    // and by the admin export; dropping it here to tidy up would break both
    // for no gain. This is additive.
    //
    // The source is recorded honestly — "footer form", "exit popup" — because
    // "why do you have my email address" needs a better answer than "somebody
    // typed it in somewhere".
    const source = String(req.body.source || 'newsletter form').slice(0, 120);
    const consent = await marketing.subscribe({
      email,
      listSlug: 'newsletter',
      source,
      ip: requestContext.current().ip,
    });
    // Never fails the signup. If the consent write fails the person has still
    // subscribed, and telling them it did not work would have them do it
    // again — which fixes nothing and annoys them twice.
    if (!consent.ok) {
      console.error('[newsletter] consent record failed for a signup:', consent.error);
    }
    recordConversionAsync({ userId: req.user ? req.user.id : null, eventName: 'newsletter_signup' });
    // Starts the reader nurture sequence in Resend. Fire-and-forget: a
    // marketing sequence is not worth failing a signup over.
    trackAsync(EVENTS.NOMINATOR_JOINED, { email, payload: { source: 'newsletter' } });
    res.status(201).json({ message: 'Subscribed — welcome to Unplug! You\'ll get our stories every Friday.' });
  } catch (err) {
    next(err);
  }
});

// GET /newsletter/subscribers — admin, newest first (for review/export).
router.get('/subscribers', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, email, subscribed_at FROM newsletter_subscribers ORDER BY subscribed_at DESC`
    );
    res.json({ subscribers: result.rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
