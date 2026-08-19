const express = require('express');
const crypto = require('crypto');
const pool = require('../db');
const { recordPaymentOnce } = require('../utils/analyticsRecorder');
const { requireAuth, requireRole } = require('../middleware/auth');
const { spendCredit, balanceFor, historyFor } = require('../utils/accountCredit');
const { priceFor, packagesFor, highlightServiceKey } = require('../utils/servicePackages');
const { logActivity } = require('./activityLog');
const { eftInstructions } = require('../utils/eftDetails');
const { attributeConsultant } = require('../utils/consultantAttribution');

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
// Self-serve advertising banners, priced by campaign length.
const AD_BANNER_PRICES = { 7: 300.00, 14: 550.00, 28: 1000.00 };
const MARKETPLACE_LISTING_DAYS = 30;

// New fees added in this pricing round.
const ARTICLE_PUBLISH_FEE = 95.00;
const EVENT_LISTING_FEE = 300.00;
const GALLERY_BUNDLE_PRICE = 100.00; // up to 3 images per bundle
const TOP10_ENTRY_FEE = 100.00;

// The current Terms & Conditions version. Bump this when the Ts&Cs change;
// historical orders keep the version they accepted. Exposed to the frontend via
// GET /payments/terms-version so both sides agree on one value.
const TERMS_VERSION = '2026.07.29';

// A unique 10-digit numeric order reference (no leading zero), checked against
// the payments table so it can never collide.
async function generateReference() {
  for (let attempt = 0; attempt < 12; attempt++) {
    const ref = String(Math.floor(1000000000 + Math.random() * 9000000000)); // 10 digits
    const exists = await pool.query('SELECT 1 FROM payments WHERE gateway_reference = $1', [ref]);
    if (exists.rowCount === 0) return ref;
  }
  throw new Error('Could not generate a unique payment reference — please try again.');
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
    // Admin-managed price (service_packages), falling back to the built-in
    // table if that row is missing — never the client's word for it.
    const price = await priceFor(highlightServiceKey(target_type), duration_days);
    if (price === null) throw new Error('That highlight package is no longer available.');
    return price;
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
  if (linkedType === 'ad_banner') {
    // Price is derived from the banner's stored duration — never the client.
    const result = await pool.query('SELECT duration_days FROM ad_slots WHERE id = $1', [linkedId]);
    if (result.rows.length === 0) throw new Error('Banner not found.');
    const price = await priceFor('ad_banner', result.rows[0].duration_days);
    if (price === null) throw new Error('Invalid banner duration.');
    return price;
  }
  if (linkedType === 'edition_download') {
    const result = await pool.query('SELECT download_price FROM editions WHERE id = $1', [linkedId]);
    if (result.rows.length === 0) throw new Error('Edition not found.');
    return Number(result.rows[0].download_price);
  }
  throw new Error(`Payments for linkedType "${linkedType}" are not implemented yet.`);
}

// Price for an order that doesn't exist in the database yet, so the checkout can
// show a real total while the member is still filling in the form. Reads the
// SAME constants as resolveAmount above — the two can't drift, and the browser
// still never supplies a price. Types whose cost is stored per-row (edition
// downloads, competition entries, profile packages) aren't quotable this way and
// say so rather than guessing.
async function priceForNewOrder(linkedType, { durationDays, targetType } = {}) {
  const FIXED = {
    article_publish: ARTICLE_PUBLISH_FEE,
    event_listing: EVENT_LISTING_FEE,
    gallery_bundle: GALLERY_BUNDLE_PRICE,
    top10_entry: TOP10_ENTRY_FEE,
    marketplace_listing: MARKETPLACE_LISTING_PRICE,
  };
  if (FIXED[linkedType] !== undefined) return FIXED[linkedType];

  if (linkedType === 'ad_banner') {
    const price = await priceFor('ad_banner', durationDays);
    if (price === null) throw new Error('Choose a valid banner duration (7, 14 or 28 days).');
    return price;
  }
  if (linkedType === 'highlight') {
    if (!['article', 'directory'].includes(targetType)) {
      throw new Error('Highlight targetType must be "article" or "directory".');
    }
    const price = await priceFor(highlightServiceKey(targetType), durationDays);
    if (price === null) throw new Error('Choose a valid highlight duration (7, 14, 21 or 28 days).');
    return price;
  }
  throw new Error(`Cannot quote "${linkedType}" before it is created — create it first, then quote by id.`);
}

// Validates a voucher code for a given user + service + amount, and
// returns the discounted amount. Does NOT record the redemption — call
// recordVoucherRedemption() only after the payment record is created,
// so a failed payment attempt doesn't burn the code.
async function applyVoucher(code, userId, linkedType, amount) {
  const result = await pool.query(
    `SELECT * FROM vouchers WHERE code = $1 AND active = true AND expires_at > now()`,
    [code.toUpperCase().trim()]
  );
  if (result.rows.length === 0) {
    throw new Error('This voucher code is invalid, expired, or no longer active.');
  }
  const voucher = result.rows[0];
  if (voucher.service_restriction && voucher.service_restriction !== linkedType) {
    throw new Error('This voucher code does not apply to this service.');
  }
  const alreadyUsed = await pool.query(
    `SELECT id FROM voucher_redemptions WHERE voucher_id = $1 AND user_id = $2`,
    [voucher.id, userId]
  );
  if (alreadyUsed.rows.length > 0) {
    throw new Error('You have already used this voucher code.');
  }
  const discountAmount = voucher.discount_type === 'percent'
    ? Math.min(amount, (amount * Number(voucher.discount_value)) / 100)
    : Math.min(amount, Number(voucher.discount_value));
  const finalAmount = Math.max(0, amount - discountAmount);
  return { voucher, discountAmount, finalAmount };
}

async function recordVoucherRedemption(voucherId, userId, linkedType, linkedId, discountAmount) {
  await pool.query(
    `INSERT INTO voucher_redemptions (voucher_id, user_id, linked_type, linked_id, discount_amount)
     VALUES ($1, $2, $3, $4, $5)`,
    [voucherId, userId, linkedType, linkedId, discountAmount]
  );
}

// Applies the real-world effect once a payment is confirmed — moves a
// profile out of 'awaiting_payment' into the Approval Queue, or completes
// a package upgrade. Called by both webhooks and the manual EFT route so
// the effect is identical regardless of payment method.
async function applyPaymentEffect(payment) {
  // Recorded FIRST, and independently of everything below. The money is
  // confirmed at this point whatever happens to the downstream effect — and
  // orders.js deliberately swallows a failing effect so one bad cart item
  // cannot block the rest, which would otherwise mean a real payment silently
  // missing from the revenue figures.
  await recordPaymentOnce(payment);

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
    // Honours a future start date the member chose at purchase, falling back to
    // today when they didn't pick one. The end date is always derived from the
    // PAID duration, so the window can never be longer than what was bought.
    await pool.query(
      `UPDATE highlights
          SET status = 'pending',
              start_date = GREATEST(COALESCE(requested_start_date, CURRENT_DATE), CURRENT_DATE),
              end_date = GREATEST(COALESCE(requested_start_date, CURRENT_DATE), CURRENT_DATE)
                         + ((duration_days - 1) || ' days')::interval
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
  } else if (payment.linked_type === 'ad_banner') {
    // Payment done → the banner moves into the admin approval queue. It only
    // goes live (is_active=true) once an admin approves it.
    await pool.query(
      `UPDATE ad_slots SET moderation_status = 'pending_approval', payment_id = $2
       WHERE id = $1 AND moderation_status = 'pending_payment'`,
      [payment.linked_id, payment.id]
    );
  } else if (payment.linked_type === 'edition_download') {
    // The buyer normally starts at POST /editions/:id/purchase, which creates
    // the row (with its reference) as 'awaiting_payment'. Approve that row.
    //
    // Matched on the newest awaiting row for this buyer and edition — the old
    // ON CONFLICT (user_id, edition_id) is gone, because a download is now
    // single-use and buying the same edition twice is legitimate.
    const pending = await pool.query(
      `UPDATE edition_purchases
          SET payment_status = 'approved', payment_id = $3, approved_at = now(), updated_at = now()
        WHERE id = (
          SELECT id FROM edition_purchases
           WHERE edition_id = $2
             AND payment_status = 'awaiting_payment'
             AND (user_id = $1 OR ($1 IS NULL AND user_id IS NULL))
           ORDER BY created_at DESC
           LIMIT 1
        )
        RETURNING id`,
      [payment.user_id, payment.linked_id, payment.id]
    );

    // No pending row — e.g. a checkout started before this flow existed. Create
    // an approved purchase so the customer still gets what they paid for.
    if (pending.rowCount === 0) {
      const { generateReference } = require('../utils/editionAccess');
      const reference = await generateReference();
      const buyer = await pool.query('SELECT email FROM users WHERE id = $1', [payment.user_id]);
      await pool.query(
        `INSERT INTO edition_purchases
           (user_id, edition_id, payment_id, customer_email, amount,
            payment_method, payment_status, download_reference, approved_at)
         VALUES ($1, $2, $3, $4, $5, 'online', 'approved', $6, now())`,
        [
          payment.user_id, payment.linked_id, payment.id,
          buyer.rows[0] ? buyer.rows[0].email : null,
          payment.amount, reference,
        ]
      );
    }
  } else if (payment.linked_type === 'vote_bundle') {
    const bundleResult = await pool.query('SELECT * FROM vote_bundles WHERE id = $1', [payment.linked_id]);
    if (bundleResult.rows.length > 0) {
      const bundle = bundleResult.rows[0];
      // A plain insert into the bundle's own votes row. This used to be an
      // upsert that merged into the buyer's existing free-vote row, because
      // the old one-row-per-voter indexes made a duplicate impossible to
      // insert. 098_daily_voting.sql replaced those indexes, so the old
      // ON CONFLICT clauses no longer match any index at all — Postgres
      // rejects such a statement outright, which would have failed every
      // online paid vote. Paid rows are excluded from the new uniqueness
      // indexes, so they need no conflict handling.
      await pool.query(
        `INSERT INTO votes (entry_id, voter_user_id, session_id, bundle_size, payment_id, vote_bundle_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          bundle.entry_id,
          bundle.buyer_user_id || null,
          bundle.buyer_user_id ? null : bundle.session_id,
          bundle.vote_count,
          payment.id,
          bundle.id,
        ]
      );
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
// GET /payments/credit — the member's own credit balance and where it came
// from. The policy tells people their credit is on their profile, so there
// has to be somewhere they can actually see it.
router.get('/credit', requireAuth, async (req, res, next) => {
  try {
    const [balance, history] = await Promise.all([
      balanceFor(req.user.id),
      historyFor(req.user.id),
    ]);
    res.json({ balance, history });
  } catch (err) {
    next(err);
  }
});

// GET /payments/terms-version — public. The current Ts&Cs version the checkout
// must record; keeps the frontend and backend on one value.
router.get('/terms-version', (req, res) => {
  res.json({ version: TERMS_VERSION });
});

// GET /payments/admin/all — admin order view: who, what, credit used, amount
// paid, method, reference, terms version + acceptance time, and a derived status
// label (Credit Paid / Partially Paid / Paid / Pending / Failed).
router.get('/admin/all', requireRole('admin'), async (req, res, next) => {
  try {
    const rows = await pool.query(
      `SELECT p.id, p.gateway_reference, p.linked_type, p.linked_id, p.amount, p.credit_used,
              p.voucher_discount, p.voucher_code,
              p.order_total, p.method, p.status, p.terms_version, p.terms_accepted_at,
              p.created_at, p.confirmed_at, u.email, u.full_name
         FROM payments p JOIN users u ON u.id = p.user_id
        ORDER BY p.created_at DESC LIMIT 500`
    );
    const orders = rows.rows.map((p) => {
      const cash = Number(p.amount) || 0;          // the EFT/gateway portion
      const credit = Number(p.credit_used) || 0;
      const voucher = Number(p.voucher_discount) || 0;
      let label;
      if (p.status === 'failed') label = 'Failed';
      // Still awaiting the EFT/gateway leg — anything already covered by
      // voucher/credit is banked, but the order isn't settled until it clears.
      else if (p.status === 'pending') label = (credit > 0 || voucher > 0) ? 'Partially Paid' : 'Pending';
      // Settled with no cash leg at all.
      else if (cash === 0 && credit > 0) label = 'Credit Paid';
      else if (cash === 0 && voucher > 0) label = 'Voucher Paid';
      // Settled, and part of it came off a voucher/credit.
      else if (credit > 0 || voucher > 0) label = 'Paid (part credit/voucher)';
      else label = 'Paid';
      return { ...p, statusLabel: label, cashPortion: cash, creditPortion: credit, voucherPortion: voucher };
    });
    res.json({ orders });
  } catch (err) { next(err); }
});

// GET /payments/packages?service=highlight_article — public. The packages a
// member can buy, with admin-managed prices. Used by the dashboard pickers so
// prices are never hardcoded in the frontend.
router.get('/packages', async (req, res, next) => {
  try {
    const service = (req.query.service || '').trim();
    const ALLOWED = ['highlight_article', 'highlight_directory', 'ad_banner'];
    if (!ALLOWED.includes(service)) {
      return res.status(400).json({ error: `service must be one of: ${ALLOWED.join(', ')}` });
    }
    res.json({ service, packages: await packagesFor(service) });
  } catch (err) { next(err); }
});

// GET /payments/admin/packages — admin, every package including inactive ones.
router.get('/admin/packages', requireRole('admin'), async (req, res, next) => {
  try {
    const r = await pool.query(
      `SELECT p.id, p.service_key, p.duration_days, p.name, p.description, p.price,
              p.active, p.display_order, p.updated_at, u.email AS updated_by_email
         FROM service_packages p
         LEFT JOIN users u ON u.id = p.updated_by
        ORDER BY p.service_key, p.display_order, p.duration_days`
    );
    res.json({ packages: r.rows });
  } catch (err) { next(err); }
});

// PATCH /payments/admin/packages/:id — admin edits price / name / description /
// availability. The duration and service are NOT editable: they're the identity
// of the package, and changing them would silently repoint existing links.
// What else in the system points at this payment. Used by both the edit and
// delete routes below, because "is it safe to touch this?" has exactly one
// correct answer and it should not be written twice.
//
// account_credits is the serious one. Its payment_id is ON DELETE SET NULL and
// a unique index on it is what stops the same payment being credited twice —
// so deleting a credited payment would leave the money credited, lose where it
// came from, AND disarm the double-credit guard.
async function paymentDependants(id) {
  const r = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM account_credits    WHERE payment_id = $1) AS credits,
       (SELECT COUNT(*)::int FROM votes              WHERE payment_id = $1) AS votes,
       (SELECT COUNT(*)::int FROM edition_purchases  WHERE payment_id = $1) AS edition_purchases,
       (SELECT COUNT(*)::int FROM ad_slots           WHERE payment_id = $1) AS banners`,
    [id]
  );
  const d = r.rows[0];
  return { ...d, blocking: d.credits + d.votes + d.edition_purchases };
}

function dependantSummary(d) {
  const parts = [];
  if (d.credits) parts.push(`${d.credits} account-credit ${d.credits === 1 ? 'entry' : 'entries'}`);
  if (d.votes) parts.push(`${d.votes} paid ${d.votes === 1 ? 'vote' : 'votes'}`);
  if (d.edition_purchases) parts.push(`${d.edition_purchases} edition ${d.edition_purchases === 1 ? 'purchase' : 'purchases'}`);
  return parts.join(', ');
}

// PATCH /payments/admin/:id — admin corrects a payment's status.
//
// This is the right tool for a test payment: marking it Failed takes it out of
// the revenue figures while the record stays, which is what accounting rules
// generally want. Deleting is below, for when the row should never have
// existed at all.
router.patch('/admin/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = await pool.query('SELECT id, status FROM payments WHERE id = $1', [id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Payment not found.' });

    const status = req.body.status;
    if (!['pending', 'confirmed', 'failed'].includes(status)) {
      return res.status(400).json({ error: 'Status must be pending, confirmed or failed.' });
    }

    // Moving a credited payment off 'confirmed' would leave account credit
    // that no longer has a confirmed payment behind it.
    if (existing.rows[0].status === 'confirmed' && status !== 'confirmed') {
      const d = await paymentDependants(id);
      if (d.credits > 0) {
        return res.status(409).json({
          error: 'This payment has already been turned into account credit. Reverse the credit first, or the customer keeps credit with no confirmed payment behind it.',
        });
      }
    }

    // Deliberately does NOT re-run applyPaymentEffect: flipping a status by
    // hand should not silently publish an article or unlock a download. Use
    // the normal confirm route for that.
    const result = await pool.query(
      // $2 is cast explicitly: used both as the new status and inside a CASE
      // whose other branch is a timestamp, Postgres otherwise deduces
      // conflicting types for the same parameter and refuses the statement.
      `UPDATE payments
          SET status = $2::varchar,
              confirmed_at = CASE WHEN $2::varchar = 'confirmed'
                                  THEN COALESCE(confirmed_at, now()) ELSE NULL END
        WHERE id = $1 RETURNING id, status`,
      [id, status]
    );
    await logActivity(req.user.id, 'payment_status_edited',
      `Payment #${id} set to ${status}`).catch(() => {});
    res.json({
      payment: result.rows[0],
      message: `Payment marked as ${status}. Nothing was published or unlocked by this change.`,
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /payments/admin/:id — removes a payment row entirely.
//
// Meant for clearing out test payments. Refused whenever the payment is part
// of something real: account credit, paid votes, or an edition purchase all
// point at it, and removing it would corrupt those records rather than tidy
// them. In those cases marking it Failed is the correct action instead.
//
// A banner's payment_id is ON DELETE SET NULL, so a banner survives with its
// payment link cleared — reported back so it isn't a surprise.
router.delete('/admin/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = await pool.query(
      'SELECT id, amount, gateway_reference, status FROM payments WHERE id = $1', [id]
    );
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Payment not found.' });

    const d = await paymentDependants(id);
    if (d.blocking > 0) {
      return res.status(409).json({
        error: `This payment is attached to ${dependantSummary(d)}. Deleting it would leave those records pointing at nothing — mark it as Failed instead, which removes it from the revenue figures and keeps the history.`,
      });
    }

    await pool.query('DELETE FROM payments WHERE id = $1', [id]);
    await logActivity(req.user.id, 'payment_deleted',
      `Deleted payment #${id} (${existing.rows[0].gateway_reference}, R${existing.rows[0].amount}, ${existing.rows[0].status})`).catch(() => {});

    res.json({
      deleted: true,
      bannersDetached: d.banners,
      message: d.banners > 0
        ? `Payment deleted. ${d.banners} banner${d.banners === 1 ? '' : 's'} kept, with the payment link cleared.`
        : 'Payment deleted.',
    });
  } catch (err) {
    // A foreign key we haven't accounted for. Report it rather than a 500 —
    // the database refusing is the system working.
    if (err.code === '23503') {
      return res.status(409).json({
        error: 'Something else in the system still refers to this payment, so it cannot be deleted. Mark it as Failed instead.',
      });
    }
    next(err);
  }
});

router.patch('/admin/packages/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'A valid package id is required.' });

    const sets = [];
    const values = [];
    const push = (col, val) => { values.push(val); sets.push(`${col} = $${values.length}`); };

    if (req.body.price !== undefined) {
      const price = Number(req.body.price);
      if (!Number.isFinite(price) || price < 0) {
        return res.status(400).json({ error: 'Price must be a number of 0 or more.' });
      }
      push('price', price);
    }
    if (req.body.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name) return res.status(400).json({ error: 'Name cannot be empty.' });
      push('name', name.slice(0, 120));
    }
    if (req.body.description !== undefined) push('description', String(req.body.description || '').trim() || null);
    if (req.body.active !== undefined) push('active', !!req.body.active);
    if (req.body.displayOrder !== undefined) push('display_order', Number(req.body.displayOrder) || 0);
    if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update.' });

    push('updated_at', new Date());
    push('updated_by', req.user.id);
    values.push(id);

    const r = await pool.query(
      `UPDATE service_packages SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'That package no longer exists.' });
    logActivity(req.user.id, 'service_package_updated', `${r.rows[0].service_key} ${r.rows[0].duration_days}d → R${Number(r.rows[0].price).toFixed(2)}`);
    res.json({ package: r.rows[0], message: 'Saved — the new price applies to new orders immediately.' });
  } catch (err) { next(err); }
});

// GET /payments/mine — the member's own payment history with the full
// breakdown per transaction, so the dashboard can show what was bought, what it
// cost, how it was paid (voucher / credit / EFT) and the reference to quote.
// Scoped to req.user.id, so one member can never read another's payments.
router.get('/mine', requireAuth, async (req, res, next) => {
  try {
    const rows = await pool.query(
      `SELECT id, gateway_reference, linked_type, linked_id, amount, credit_used,
              voucher_discount, voucher_code, order_total, method, status,
              pop_url, invoice_url, receipt_url,
              created_at, confirmed_at
         FROM payments
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 100`,
      [req.user.id]
    );
    const SERVICE_LABELS = {
      profile_package: 'Directory Package', profile_upgrade: 'Package Upgrade',
      competition_entry: 'Competition Entry', highlight: 'Highlight',
      marketplace_listing: 'Marketplace Poster', vote_bundle: 'Vote Bundle',
      article_publish: 'Article Submission', event_listing: 'Event Listing',
      gallery_bundle: 'Gallery Bundle', top10_entry: 'Top 10 Entry',
      edition_download: 'Edition Download', ad_banner: 'Page Banner',
    };
    const payments = rows.rows.map((p) => {
      const cash = Number(p.amount) || 0;
      const credit = Number(p.credit_used) || 0;
      const voucher = Number(p.voucher_discount) || 0;
      let label;
      if (p.status === 'failed') label = 'Failed';
      else if (p.status === 'pending') label = (credit > 0 || voucher > 0) ? 'Partially Paid' : 'Awaiting Payment';
      else if (cash === 0 && credit > 0) label = 'Paid by Credit';
      else if (cash === 0 && voucher > 0) label = 'Paid by Voucher';
      else label = 'Paid';
      return {
        ...p,
        serviceLabel: SERVICE_LABELS[p.linked_type] || p.linked_type,
        statusLabel: label,
        cashPortion: cash, creditPortion: credit, voucherPortion: voucher,
      };
    });
    res.json({ payments });
  } catch (err) { next(err); }
});

// PATCH /payments/:id/proof — attaches a proof-of-payment URL (already
// uploaded via POST /uploads/proof) to the payer's own payment. Optional —
// EFT works the same without it — but speeds up admin approval. Overwrites
// any previous upload rather than keeping a history: only the latest proof
// matters for review, and the old file simply becomes unreferenced.
router.patch('/:id/proof', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const url = String(req.body.url || '').trim();
    if (!url) return res.status(400).json({ error: 'A file URL is required — upload via POST /uploads/proof first.' });
    const result = await pool.query(
      `UPDATE payments SET pop_url = $1 WHERE id = $2 AND user_id = $3 RETURNING id, pop_url`,
      [url, id, req.user.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Payment not found.' });
    res.json({ payment: result.rows[0], message: 'Proof of payment attached — thank you.' });
  } catch (err) { next(err); }
});

// POST /payments/quote — what this order would cost, worked out by the SERVER,
// before any money moves. The checkout shows this breakdown so the member can
// see exactly what they're paying and how voucher/credit reduce it.
//
// Nothing here is trusted from the browser: the price comes from resolveAmount
// (the database), the voucher is validated the same way /initiate validates it,
// and credit is capped at the balance. It writes nothing — no voucher is
// redeemed and no credit is spent by asking for a quote.
router.post('/quote', requireAuth, async (req, res, next) => {
  try {
    const { linkedType, linkedId, voucherCode, useCredit, durationDays, targetType } = req.body;

    // A quote is usually needed BEFORE the thing being paid for exists (the
    // member is still filling in the form), so there's no linkedId to price
    // against yet. Price those from the same server-side constants
    // resolveAmount uses; once a linkedId exists we defer to resolveAmount so a
    // quote and the real charge can never disagree.
    let orderTotal;
    if (linkedId) {
      orderTotal = await resolveAmount(linkedType, linkedId);
    } else {
      orderTotal = await priceForNewOrder(linkedType, { durationDays, targetType });
    }

    let voucherDiscount = 0;
    let voucherError = null;
    let afterVoucher = orderTotal;
    if (voucherCode) {
      try {
        const v = await applyVoucher(voucherCode, req.user.id, linkedType, orderTotal);
        afterVoucher = v.finalAmount;
        voucherDiscount = Number((orderTotal - afterVoucher).toFixed(2));
      } catch (e) {
        // A bad code shouldn't blank the whole quote — report it and price the
        // order without it, so the form can show the message inline.
        voucherError = e.message;
      }
    }

    const creditBalance = await balanceFor(req.user.id);
    // Never more than what's still owed — the same MIN() rule spendCredit uses,
    // so a R150 balance against a R100 order only ever uses R100.
    const creditApplied = useCredit === true
      ? Number(Math.min(creditBalance, afterVoucher).toFixed(2))
      : 0;
    const amountToPay = Number((afterVoucher - creditApplied).toFixed(2));

    res.json({
      linkedType,
      linkedId,
      orderTotal,
      voucherDiscount,
      voucherCode: voucherDiscount > 0 ? voucherCode : null,
      voucherError,
      creditBalance,
      creditApplied,
      creditRemainingAfter: Number((creditBalance - creditApplied).toFixed(2)),
      amountToPay,
      // True when voucher+credit already cover it — the UI can then say
      // "nothing to pay" instead of offering EFT instructions for R0.
      settledWithoutPayment: amountToPay === 0,
    });
  } catch (err) {
    next(err);
  }
});

const REFERRAL_SOURCES = ['google', 'facebook', 'instagram', 'linkedin', 'tiktok', 'sales_consultant', 'other'];

router.post('/initiate', requireAuth, async (req, res, next) => {
  try {
    const { linkedType, linkedId, method, referralSource, salesConsultantId, voucherCode, useCredit, termsAccepted } = req.body;
    if (!['payfast', 'ozow', 'eft'].includes(method)) {
      return res.status(400).json({ error: 'method must be one of: payfast, ozow, eft' });
    }
    // MANDATORY Terms & Conditions gate — enforced server-side, per order. Every
    // new paid order must actively accept the current Ts&Cs; there is no bypass
    // and no "already accepted before" exemption.
    if (termsAccepted !== true) {
      return res.status(400).json({ error: 'You must read and accept the current Unplug Terms & Conditions and Cancellation, Refund & Account Credit Policy before checkout.' });
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

    // A self-serve banner can only be paid for by the member who submitted it,
    // and only while it's still awaiting payment.
    if (linkedType === 'ad_banner') {
      const own = await pool.query('SELECT owner_user_id, moderation_status FROM ad_slots WHERE id = $1', [linkedId]);
      if (own.rows.length === 0) return res.status(404).json({ error: 'Banner not found.' });
      if (own.rows[0].owner_user_id !== req.user.id) return res.status(403).json({ error: 'That banner is not yours.' });
      if (own.rows[0].moderation_status !== 'pending_payment') return res.status(400).json({ error: 'This banner has already been paid for.' });
    }

    const amount = await resolveAmount(linkedType, linkedId);

    let finalAmount = amount;
    let appliedVoucher = null;
    if (voucherCode) {
      const voucherResult = await applyVoucher(voucherCode, req.user.id, linkedType, amount);
      finalAmount = voucherResult.finalAmount;
      appliedVoucher = voucherResult.voucher;
    }

    const reference = await generateReference();

    // Account credit is applied ONLY when the user opts in (useCredit === true),
    // and never more than the order total: MIN(available, total). Server-side
    // math — the client can't dictate how much credit is spent. The deduction
    // and the payment row are written in ONE transaction: spending someone's
    // credit and then failing to create the payment would take their money and
    // give them nothing.
    let payment;
    let creditUsed = 0;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      if (useCredit === true) {
        creditUsed = await spendCredit(
          client,
          req.user.id,
          finalAmount,
          `Applied to ${linkedType} #${linkedId} (${reference})`
        );
      }
      const payable = Number((finalAmount - creditUsed).toFixed(2));

      // Who earns commission on this payment. The buyer's checkout selection
      // is only the LAST of three rules — an admin assignment, then the
      // consultant the member named at signup, both outrank it. See
      // utils/consultantAttribution.js for the order and why it lives there.
      const attributed = await attributeConsultant(
        req.user.id,
        referralSource === 'sales_consultant' ? salesConsultantId : null,
        client
      );

      const result = await client.query(
        `INSERT INTO payments (user_id, amount, method, gateway_reference, linked_type, linked_id, referral_source, sales_consultant_id,
                               consultant_source,
                               terms_version, terms_accepted_at, terms_ip, terms_user_agent, credit_used, order_total,
                               voucher_discount, voucher_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), $11, $12, $13, $14, $15, $16)
         RETURNING *`,
        // order_total is the FULL price before any discount, so the stored
        // breakdown reconciles: order_total - voucher_discount - credit_used = amount.
        [req.user.id, payable, method, reference, linkedType, linkedId, referralSource || null,
          attributed.consultantId, attributed.source,
          TERMS_VERSION, req.ip, req.get('user-agent') || null, creditUsed, amount,
          Number((amount - finalAmount).toFixed(2)), appliedVoucher ? voucherCode : null]
      );
      payment = result.rows[0];

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    if (appliedVoucher) {
      await recordVoucherRedemption(appliedVoucher.id, req.user.id, linkedType, linkedId, amount - finalAmount);
    }

    // Credit covered the whole amount, so there is nothing to pay. Sending the
    // member to a gateway for R0.00 — or to EFT instructions telling them to
    // transfer nothing — would leave the submission stuck awaiting a payment
    // that can never arrive. Confirm it here instead.
    if (Number(payment.amount) === 0) {
      await pool.query(
        `UPDATE payments SET status = 'confirmed', confirmed_at = now() WHERE id = $1`,
        [payment.id]
      );
      const confirmed = await pool.query('SELECT * FROM payments WHERE id = $1', [payment.id]);
      await applyPaymentEffect(confirmed.rows[0]);
      return res.status(201).json({
        payment: confirmed.rows[0],
        creditUsed,
        paidInFull: true,
        message: `Covered in full by your R${creditUsed.toFixed(2)} account credit — nothing to pay.`,
      });
    }

    if (method === 'eft') {
      return res.status(201).json({
        payment,
        creditUsed,
        instructions: eftInstructions(reference),
      });
    }

    // PayFast/Ozow: in production this returns a real hosted-checkout URL
    // built from the gateway's SDK/API using the merchant credentials and
    // this reference. Stubbed here since that requires live credentials.
    res.status(201).json({
      payment,
      creditUsed,
      // payment.amount, not the original price — the gateway must charge what
      // is actually still owed after voucher and credit, not the list price.
      redirectUrl: `https://sandbox.${method}.example.com/checkout?ref=${reference}&amount=${payment.amount}`,
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

// Attached to the router function itself (not a separate export shape) so
// app.js's existing `app.use('/payments', require('./payments'))` keeps
// working unchanged, while orders.js (Payment Portal Redevelopment Phase 3
// — the multi-service cart) can reuse the exact same per-service pricing,
// voucher and "what actually happens once paid" logic rather than
// re-implementing an 11-branch (now 12, with vote_bundle excluded — see
// 095) copy that could drift from this one. Same pattern already used by
// interactions.js's notifyProfileOwner.
router.resolveAmount = resolveAmount;
router.applyVoucher = applyVoucher;
router.recordVoucherRedemption = recordVoucherRedemption;
router.applyPaymentEffect = applyPaymentEffect;
router.TERMS_VERSION = TERMS_VERSION;

module.exports = router;
