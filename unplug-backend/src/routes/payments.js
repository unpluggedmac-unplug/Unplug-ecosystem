const express = require('express');
const crypto = require('crypto');
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// PayFast posts application/x-www-form-urlencoded ITN data, not JSON —
// this parser is scoped to just the PayFast webhook route below (the rest
// of the API uses express.json(), mounted globally in app.js).
const urlencodedParser = express.urlencoded({ extended: false });

// ---------------------------------------------------------------------------
// PayFast ITN signature verification, per PayFast's published validation
// steps: rebuild the parameter string from every field EXCEPT `signature`,
// in the order they were posted, URL-encoded with spaces as '+', append
// the merchant passphrase if one is configured, then MD5 hash it and
// compare to the `signature` field PayFast sent.
//
// PAYFAST_PASSPHRASE must be set in .env to match what's configured in
// the PayFast merchant dashboard — if it's unset, verification is SKIPPED
// with a loud warning rather than silently trusting the payload. This is
// acceptable for local development only.
function verifyPayfastSignature(body) {
  const passphrase = process.env.PAYFAST_PASSPHRASE;
  if (!passphrase) {
    console.warn('[payments] PAYFAST_PASSPHRASE is not set — skipping ITN signature verification. Do not accept real payments like this.');
    return true;
  }

  const receivedSignature = body.signature;
  const pairs = Object.keys(body)
    .filter((key) => key !== 'signature')
    .map((key) => `${key}=${encodeURIComponent(body[key]).replace(/%20/g, '+')}`);
  pairs.push(`passphrase=${encodeURIComponent(passphrase).replace(/%20/g, '+')}`);

  const computedSignature = crypto.createHash('md5').update(pairs.join('&')).digest('hex');
  return computedSignature === receivedSignature;
}

// ---------------------------------------------------------------------------
// Ozow HashCheck verification, per Ozow's published notify-callback spec:
// concatenate the specific set of response fields (in Ozow's documented
// order) with the merchant's private key appended, lowercase the whole
// string, then SHA512 hash it and compare to `HashCheck`.
//
// OZOW_PRIVATE_KEY must be set in .env — same skip-with-warning behavior
// as PayFast above if it's missing.
//
// NOTE: this has been implemented from Ozow's documented field order at
// the time of writing, but could not be tested against a live Ozow
// account in this environment — confirm the exact field list/order
// against Ozow's current API docs (or a sandbox transaction) before
// relying on it in production.
function verifyOzowHash(body) {
  const privateKey = process.env.OZOW_PRIVATE_KEY;
  if (!privateKey) {
    console.warn('[payments] OZOW_PRIVATE_KEY is not set — skipping HashCheck verification. Do not accept real payments like this.');
    return true;
  }

  const receivedHash = body.HashCheck;
  const fieldOrder = [
    'SiteCode', 'TransactionId', 'TransactionReference', 'Amount', 'Status',
    'Optional1', 'Optional2', 'Optional3', 'Optional4', 'Optional5',
    'CurrencyCode', 'IsTest', 'StatusMessage',
  ];
  const concatenated = fieldOrder.map((field) => body[field] ?? '').join('') + privateKey;
  const computedHash = crypto.createHash('sha512').update(concatenated.toLowerCase()).digest('hex');
  return computedHash === receivedHash;
}

const PACKAGE_PRICES = {
  individual: { basic: 150.00, pro: 280.00, premium: 400.00 },
  business:   { basic: 500.00, pro: 700.00, premium: 1000.00 },
};

// Highlights & Promotions pricing — optional homepage boost, unchanged
// from the original locked pricing.
const HIGHLIGHT_PRICES = {
  article: { 7: 150.00, 14: 250.00, 21: 300.00, 28: 450.00 },
  directory: { 7: 100.00, 14: 150.00, 21: 200.00, 28: 250.00 },
};

// Marketplace: flat R500 for a fixed 30-day duration (replaces the old
// tiered 7/14/21/28-day Business Banner pricing).
const MARKETPLACE_LISTING_PRICE = 500.00;
const MARKETPLACE_LISTING_DAYS = 30;

// New fees added in this pricing round.
const ARTICLE_PUBLISH_FEE = 95.00;
const EVENT_LISTING_FEE = 300.00;
const GALLERY_BUNDLE_PRICE = 100.00; // up to 3 images per bundle
const TOP10_ENTRY_FEE = 100.00;

function generateReference() {
  return 'UNPLUG-' + crypto.randomBytes(8).toString('hex').toUpperCase();
}

// Works out the correct amount for a given linked_type/linked_id, from the
// database rather than the request body.
async function resolveAmount(linkedType, linkedId) {
  if (linkedType === 'profile_package') {
    const result = await pool.query('SELECT package_tier, type FROM profiles WHERE id = $1', [linkedId]);
    if (result.rows.length === 0) throw new Error('Profile not found.');
    const { package_tier, type } = result.rows[0];
    return PACKAGE_PRICES[type][package_tier];
  }
  if (linkedType === 'profile_upgrade') {
    const result = await pool.query('SELECT fee_paid FROM profile_upgrades WHERE id = $1', [linkedId]);
    if (result.rows.length === 0) throw new Error('Upgrade request not found.');
    return Number(result.rows[0].fee_paid) || UPGRADE_FEE;
  }
  if (linkedType === 'competition_entry') {
    // Each competition sets its own entry fee (e.g. The Arena = R250) —
    // read from the entry itself, which was set from competitions.entry_fee
    // at the time the entry was created.
    const result = await pool.query('SELECT entry_fee FROM competition_entries WHERE id = $1', [linkedId]);
    if (result.rows.length === 0) throw new Error('Competition entry not found.');
    return Number(result.rows[0].entry_fee);
  }
  if (linkedType === 'highlight') {
    const result = await pool.query('SELECT target_type, duration_days FROM highlights WHERE id = $1', [linkedId]);
    if (result.rows.length === 0) throw new Error('Highlight not found.');
    const { target_type, duration_days } = result.rows[0];
    return HIGHLIGHT_PRICES[target_type][duration_days];
  }
  if (linkedType === 'marketplace_listing') {
    const result = await pool.query('SELECT id FROM marketplace_listings WHERE id = $1', [linkedId]);
    if (result.rows.length === 0) throw new Error('Marketplace listing not found.');
    return MARKETPLACE_LISTING_PRICE;
  }
  if (linkedType === 'vote_bundle') {
    const result = await pool.query('SELECT price FROM vote_bundles WHERE id = $1', [linkedId]);
    if (result.rows.length === 0) throw new Error('Vote bundle not found.');
    return Number(result.rows[0].price);
  }
  if (linkedType === 'article_publish') {
    const result = await pool.query('SELECT id FROM articles WHERE id = $1', [linkedId]);
    if (result.rows.length === 0) throw new Error('Article not found.');
    return ARTICLE_PUBLISH_FEE;
  }
  if (linkedType === 'event_listing') {
    const result = await pool.query('SELECT id FROM events WHERE id = $1', [linkedId]);
    if (result.rows.length === 0) throw new Error('Event not found.');
    return EVENT_LISTING_FEE;
  }
  if (linkedType === 'gallery_bundle') {
    const result = await pool.query('SELECT price FROM gallery_bundles WHERE id = $1', [linkedId]);
    if (result.rows.length === 0) throw new Error('Gallery bundle not found.');
    return Number(result.rows[0].price);
  }
  if (linkedType === 'top10_entry') {
    const result = await pool.query('SELECT entry_fee FROM top10_entries WHERE id = $1', [linkedId]);
    if (result.rows.length === 0) throw new Error('Top 10 entry not found.');
    return Number(result.rows[0].entry_fee);
  }
  if (linkedType === 'edition_download') {
    const result = await pool.query('SELECT download_price FROM editions WHERE id = $1', [linkedId]);
    if (result.rows.length === 0) throw new Error('Edition not found.');
    return Number(result.rows[0].download_price);
  }
  throw new Error(`Payments for linkedType "${linkedType}" are not implemented yet.`);
}

// Applies the real-world effect once a payment is confirmed — moves a
// profile out of 'awaiting_payment' into the Approval Queue, or completes
// a package upgrade. Called by both webhooks and the manual EFT route so
// the effect is identical regardless of payment method.
async function applyPaymentEffect(payment) {
  if (payment.linked_type === 'profile_package') {
    await pool.query(
      `UPDATE profiles SET status = 'pending', updated_at = now()
       WHERE id = $1 AND status = 'awaiting_payment'`,
      [payment.linked_id]
    );
  } else if (payment.linked_type === 'profile_upgrade') {
    const upgrade = await pool.query('SELECT * FROM profile_upgrades WHERE id = $1', [payment.linked_id]);
    if (upgrade.rows.length > 0) {
      const { profile_id, to_tier } = upgrade.rows[0];
      await pool.query('UPDATE profiles SET package_tier = $1, updated_at = now() WHERE id = $2', [to_tier, profile_id]);
      await pool.query('UPDATE profile_upgrades SET paid_at = now() WHERE id = $1', [payment.linked_id]);
    }
  } else if (payment.linked_type === 'competition_entry') {
    await pool.query(
      `UPDATE competition_entries SET status = 'pending'
       WHERE id = $1 AND status = 'awaiting_payment'`,
      [payment.linked_id]
    );
  } else if (payment.linked_type === 'highlight') {
    // Sets the active window starting today, running for the paid duration.
    // The admin approval step (which flips status to 'approved') is still
    // required before it actually renders with the "Highlighted" badge —
    // payment alone only gets it into the queue.
    await pool.query(
      `UPDATE highlights
       SET status = 'pending', start_date = CURRENT_DATE, end_date = CURRENT_DATE + (duration_days || ' days')::interval
       WHERE id = $1 AND status = 'awaiting_payment'`,
      [payment.linked_id]
    );
  } else if (payment.linked_type === 'marketplace_listing') {
    // Uses the advertiser's requested_start_date if they gave one (set at
    // /marketplace/listings creation), otherwise starts today. Always a
    // fixed 30-day run per the flat R500 pricing.
    await pool.query(
      `UPDATE marketplace_listings
       SET status = 'pending',
           active_from = COALESCE(requested_start_date, CURRENT_DATE),
           active_to = COALESCE(requested_start_date, CURRENT_DATE) + interval '30 days'
       WHERE id = $1 AND status = 'awaiting_payment'`,
      [payment.linked_id]
    );
  } else if (payment.linked_type === 'article_publish') {
    await pool.query(
      `UPDATE articles SET status = 'pending' WHERE id = $1 AND status = 'awaiting_payment'`,
      [payment.linked_id]
    );
  } else if (payment.linked_type === 'event_listing') {
    await pool.query(
      `UPDATE events SET status = 'pending' WHERE id = $1 AND status = 'awaiting_payment'`,
      [payment.linked_id]
    );
  } else if (payment.linked_type === 'gallery_bundle') {
    await pool.query(
      `UPDATE gallery_bundles SET status = 'pending' WHERE id = $1 AND status = 'awaiting_payment'`,
      [payment.linked_id]
    );
    await pool.query(
      `UPDATE gallery_images SET status = 'pending' WHERE bundle_id = $1`,
      [payment.linked_id]
    );
  } else if (payment.linked_type === 'top10_entry') {
    await pool.query(
      `UPDATE top10_entries SET status = 'pending' WHERE id = $1 AND status = 'awaiting_payment'`,
      [payment.linked_id]
    );
  } else if (payment.linked_type === 'edition_download') {
    // Unlike everything else, there's no "awaiting_payment" row to flip —
    // paying for an edition download directly creates the purchase record
    // that GET /editions/:id/download checks for.
    await pool.query(
      `INSERT INTO edition_purchases (user_id, edition_id, payment_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, edition_id) DO NOTHING`,
      [payment.user_id, payment.linked_id, payment.id]
    );
  } else if (payment.linked_type === 'vote_bundle') {
    const bundleResult = await pool.query('SELECT * FROM vote_bundles WHERE id = $1', [payment.linked_id]);
    if (bundleResult.rows.length > 0) {
      const bundle = bundleResult.rows[0];
      // Upsert rather than plain insert: if this voter/session already cast
      // their one free vote for this entry, that row already exists (the
      // unique indexes in 005_competitions.sql enforce one row per voter
      // per entry) — so a bundle purchase must ADD to its bundle_size,
      // not fail as a duplicate.
      if (bundle.buyer_user_id) {
        await pool.query(
          `INSERT INTO votes (entry_id, voter_user_id, bundle_size, payment_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (entry_id, voter_user_id) WHERE voter_user_id IS NOT NULL
           DO UPDATE SET bundle_size = votes.bundle_size + EXCLUDED.bundle_size, payment_id = EXCLUDED.payment_id`,
          [bundle.entry_id, bundle.buyer_user_id, bundle.vote_count, payment.id]
        );
      } else {
        await pool.query(
          `INSERT INTO votes (entry_id, session_id, bundle_size, payment_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (entry_id, session_id) WHERE voter_user_id IS NULL
           DO UPDATE SET bundle_size = votes.bundle_size + EXCLUDED.bundle_size, payment_id = EXCLUDED.payment_id`,
          [bundle.entry_id, bundle.session_id, bundle.vote_count, payment.id]
        );
      }
      await pool.query(`UPDATE vote_bundles SET status = 'confirmed' WHERE id = $1`, [bundle.id]);
    }
  }
  // Every paid feature now follows the identical pattern:
  // create (awaiting_payment) → pay → applyPaymentEffect (pending) →
  // admin approve → live. No further linked_types are anticipated at
  // this time, but adding one is just a new `else if` block here plus
  // a matching case in resolveAmount() above.
}

// ---------------------------------------------------------------------------
// POST /payments/initiate
// Member starts a payment for something they already created (a profile
// package, an upgrade, etc). Returns what the frontend needs to either
// redirect to a hosted checkout (PayFast/Ozow) or show bank details (EFT).
// ---------------------------------------------------------------------------
const REFERRAL_SOURCES = ['google', 'facebook', 'instagram', 'linkedin', 'tiktok', 'sales_consultant', 'other'];

router.post('/initiate', requireAuth, async (req, res, next) => {
  try {
    const { linkedType, linkedId, method, referralSource, salesConsultantId } = req.body;
    if (!['payfast', 'ozow', 'eft'].includes(method)) {
      return res.status(400).json({ error: 'method must be one of: payfast, ozow, eft' });
    }
    if (referralSource && !REFERRAL_SOURCES.includes(referralSource)) {
      return res.status(400).json({ error: `referralSource must be one of: ${REFERRAL_SOURCES.join(', ')}` });
    }
    if (referralSource === 'sales_consultant' && !salesConsultantId) {
      return res.status(400).json({ error: 'salesConsultantId is required when referralSource is "sales_consultant".' });
    }
    if (salesConsultantId) {
      const consultantCheck = await pool.query('SELECT id FROM sales_consultants WHERE id = $1 AND active = true', [salesConsultantId]);
      if (consultantCheck.rows.length === 0) {
        return res.status(400).json({ error: 'salesConsultantId does not match an active consultant.' });
      }
    }

    const amount = await resolveAmount(linkedType, linkedId);
    const reference = generateReference();

    const result = await pool.query(
      `INSERT INTO payments (user_id, amount, method, gateway_reference, linked_type, linked_id, referral_source, sales_consultant_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [req.user.id, amount, method, reference, linkedType, linkedId, referralSource || null, referralSource === 'sales_consultant' ? salesConsultantId : null]
    );
    const payment = result.rows[0];

    if (method === 'eft') {
      return res.status(201).json({
        payment,
        instructions: {
          bank: 'Standard Bank',
          accountName: 'Unplug Magazine (Pty) Ltd',
          accountNumber: '000000000',
          branchCode: '051001',
          reference,
          note: 'Use this exact reference in your EFT so we can match your payment. It will be confirmed manually by an admin once received.',
        },
      });
    }

    // PayFast/Ozow: in production this returns a real hosted-checkout URL
    // built from the gateway's SDK/API using the merchant credentials and
    // this reference. Stubbed here since that requires live credentials.
    res.status(201).json({
      payment,
      redirectUrl: `https://sandbox.${method}.example.com/checkout?ref=${reference}&amount=${amount}`,
      note: `Stub URL — replace with a real ${method === 'payfast' ? 'PayFast' : 'Ozow'} checkout link once merchant credentials are available.`,
    });
  } catch (err) {
    if (err.message.includes('not found') || err.message.includes('not implemented')) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /payments/payfast/webhook
// PayFast's ITN (Instant Transaction Notification) callback. Verifies the
// signature per PayFast's documented algorithm before trusting the payload
// — see verifyPayfastSignature() above.
// ---------------------------------------------------------------------------
router.post('/payfast/webhook', urlencodedParser, async (req, res, next) => {
  try {
    if (!verifyPayfastSignature(req.body)) {
      console.warn('[payments] PayFast ITN signature mismatch — rejecting.', req.body);
      return res.status(400).send('Invalid signature');
    }
    const { reference, status } = req.body;
    await handleGatewayCallback(reference, status);
    res.sendStatus(200);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /payments/ozow/webhook
// Ozow's notify callback. Verifies HashCheck per Ozow's documented
// algorithm before trusting the payload — see verifyOzowHash() above.
// ---------------------------------------------------------------------------
router.post('/ozow/webhook', async (req, res, next) => {
  try {
    if (!verifyOzowHash(req.body)) {
      console.warn('[payments] Ozow HashCheck mismatch — rejecting.', req.body);
      return res.status(400).send('Invalid hash');
    }
    const { reference, status } = req.body;
    await handleGatewayCallback(reference, status);
    res.sendStatus(200);
  } catch (err) {
    next(err);
  }
});

// Creates an admin notification when a confirmed payment is attributed to
// a sales consultant, so commission-relevant activity surfaces without an
// admin having to go looking for it in the full payments table.
async function notifySalesConsultantPayment(payment) {
  if (!payment.sales_consultant_id) return;
  const consultant = await pool.query('SELECT name FROM sales_consultants WHERE id = $1', [payment.sales_consultant_id]);
  const name = consultant.rows[0] ? consultant.rows[0].name : `#${payment.sales_consultant_id}`;
  await pool.query(
    `INSERT INTO admin_notifications (type, message, related_payment_id)
     VALUES ('sales_consultant_payment', $1, $2)`,
    [`R${payment.amount} payment confirmed — referred by sales consultant ${name}.`, payment.id]
  );
}

async function handleGatewayCallback(reference, status) {
  const result = await pool.query('SELECT * FROM payments WHERE gateway_reference = $1', [reference]);
  if (result.rows.length === 0) return; // unknown reference — ignore silently, log in production
  const payment = result.rows[0];
  if (payment.status !== 'pending') return; // already processed — webhooks can arrive more than once

  const newStatus = status === 'success' || status === 'COMPLETE' ? 'confirmed' : 'failed';
  await pool.query('UPDATE payments SET status = $1, confirmed_at = now() WHERE id = $2', [newStatus, payment.id]);

  if (newStatus === 'confirmed') {
    await applyPaymentEffect({ ...payment, status: newStatus });
    await notifySalesConsultantPayment(payment);
  }
}

// ---------------------------------------------------------------------------
// PATCH /payments/:id/confirm-eft
// Admin-only — manual confirmation after checking the bank statement,
// since EFT has no automatic callback.
// ---------------------------------------------------------------------------
router.patch('/:id/confirm-eft', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM payments WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Payment not found.' });
    }
    const payment = result.rows[0];
    if (payment.method !== 'eft') {
      return res.status(400).json({ error: 'This endpoint is only for manual EFT payments.' });
    }
    if (payment.status !== 'pending') {
      return res.status(400).json({ error: `Payment is already ${payment.status}.` });
    }

    await pool.query('UPDATE payments SET status = $1, confirmed_at = now() WHERE id = $2', ['confirmed', payment.id]);
    await applyPaymentEffect(payment);
    await notifySalesConsultantPayment(payment);

    res.json({ message: 'EFT payment confirmed and applied.' });
  } catch (err) {
    next(err);
  }
});

// GET /payments/pending-eft — admin-only, the EFT tab of the Approval Queue.
router.get('/pending-eft', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, user_id, amount, gateway_reference, linked_type, linked_id, created_at
       FROM payments
       WHERE method = 'eft' AND status = 'pending'
       ORDER BY created_at ASC`
    );
    res.json({ payments: result.rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
