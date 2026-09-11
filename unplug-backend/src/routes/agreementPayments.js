// Agreement Forms payment bridge.
//
// Option C, selected by the site owner: admin decides PER AGREEMENT whether a
// paid signer may pay as a guest or must use an Unplug account.
//
// Money still lives in the existing payments table. This router exists only
// because the ordinary /payments/initiate route is intentionally member-only,
// while some agreements are sent to external people who may never need an
// Unplug account. EFT is the only live initiation method on this codebase today;
// PayFast/Ozow remain server-side disabled until real hosted checkout creation
// exists in routes/payments.js.

const express = require('express');
const pool = require('../db');
const { requireRole } = require('../middleware/auth');
const { publicSubmitLimiter } = require('../middleware/rateLimit');
const { generateUnique } = require('../utils/reference');
const { eftInstructions } = require('../utils/eftDetails');
const paymentRoutes = require('./payments');

const router = express.Router();
const TERMS_VERSION = paymentRoutes.TERMS_VERSION;

function activeNow(agreement) {
  const now = Date.now();
  if (!agreement || agreement.status !== 'active') return false;
  if (agreement.opens_at && new Date(agreement.opens_at).getTime() > now) return false;
  if (agreement.closes_at && new Date(agreement.closes_at).getTime() <= now) return false;
  return true;
}

function validEmail(value) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(value || '').trim());
}

function safeName(value) {
  const out = String(value || '').trim().slice(0, 200);
  return out || null;
}

async function agreementBySlug(slug, client = pool) {
  const r = await client.query(
    `SELECT id, slug, title, status, opens_at, closes_at, amount, payment_mode,
            guest_payment_allowed
       FROM agreement_forms
      WHERE LOWER(slug) = LOWER($1)`,
    [slug]
  );
  return r.rows[0] || null;
}

async function memberIdentity(userId, client = pool) {
  if (!userId) return null;
  const r = await client.query('SELECT id, full_name, email FROM users WHERE id = $1', [userId]);
  return r.rows[0] || null;
}

function paymentResponse(payment, submission) {
  const status = payment.status;
  const readyToSign = status === 'confirmed' && submission.payment_mode_at_signing === 'before_sign';
  return {
    payment: {
      id: payment.id,
      reference: payment.gateway_reference,
      amount: Number(payment.amount),
      method: payment.method,
      status,
      statusLabel: status === 'confirmed' ? 'Paid' : status === 'failed' ? 'Failed' : 'Awaiting Payment',
    },
    submissionId: submission.id,
    signingToken: submission.signing_token || null,
    nextAction: readyToSign
      ? 'sign_agreement'
      : status === 'confirmed'
        ? 'complete'
        : 'wait_for_payment_confirmation',
    instructions: payment.method === 'eft' && status === 'pending'
      ? eftInstructions(payment.gateway_reference)
      : null,
  };
}

async function paymentForSubmission(submissionId, client = pool) {
  const r = await client.query(
    `SELECT * FROM payments
      WHERE linked_type = 'agreement_payment' AND linked_id = $1
        AND status IN ('pending', 'confirmed')
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [submissionId]
  );
  return r.rows[0] || null;
}

function paymentSnapshotRequest(body) {
  const submissionId = Number(body && body.submissionId);
  const signingToken = String((body && body.signingToken) || '').trim();
  return {
    submissionId: Number.isInteger(submissionId) ? submissionId : null,
    signingToken: signingToken || null,
    hasCredential: Number.isInteger(submissionId) || Boolean(signingToken),
  };
}

async function authorisedSubmission({ agreement, body, user, client }) {
  const requested = paymentSnapshotRequest(body);

  // AFTER-SIGN payment is selected by the immutable signed submission, NOT by
  // agreement_forms.payment_mode as it looks today. An admin may legitimately
  // edit/close/archive the agreement after somebody signs. That must never
  // erase the amount or payment route the signer already agreed to.
  if (requested.submissionId !== null) {
    const r = await client.query(
      `SELECT * FROM agreement_submissions
        WHERE id = $1 AND agreement_id = $2 AND signed_at IS NOT NULL`,
      [requested.submissionId, agreement.id]
    );
    if (!r.rowCount) {
      const err = new Error('Signed agreement record not found.');
      err.statusCode = 404;
      throw err;
    }
    const s = r.rows[0];

    if (s.payment_mode_at_signing !== 'after_sign' || Number(s.amount_at_signing) <= 0) {
      const err = new Error('This signed agreement does not require a post-signing payment.');
      err.statusCode = 400;
      throw err;
    }

    // A member-owned signed record can only be paid by that member. A guest
    // record always needs its private download token, even if the caller happens
    // to be logged in, so knowing a sequential submission id is never enough.
    if (s.user_id) {
      if (!user) {
        const err = new Error('This signed agreement belongs to an Unplug account. Sign in to continue.');
        err.statusCode = 401;
        throw err;
      }
      if (Number(s.user_id) !== Number(user.id)) {
        const err = new Error('That signed agreement belongs to another account.');
        err.statusCode = 403;
        throw err;
      }
    } else {
      if (!s.guest_payment_allowed_at_signing) {
        const err = new Error('This agreement required an Unplug account for payment.');
        err.statusCode = 401;
        throw err;
      }
      if (!s.download_token || String(body.downloadToken || '') !== s.download_token) {
        const err = new Error('That guest payment link is not valid.');
        err.statusCode = 403;
        throw err;
      }
    }
    return s;
  }

  // BEFORE-SIGN payment: resume by signingToken when the browser already has a
  // session. The session's amount and guest policy are authoritative even if an
  // admin changes the agreement after this person started.
  if (requested.signingToken) {
    const r = await client.query(
      `SELECT * FROM agreement_submissions
        WHERE agreement_id = $1 AND signing_token = $2
          AND signed_at IS NULL AND payment_mode_at_signing = 'before_sign'`,
      [agreement.id, requested.signingToken]
    );
    if (!r.rowCount) {
      const err = new Error('That signing/payment session is not valid.');
      err.statusCode = 404;
      throw err;
    }
    const s = r.rows[0];

    if (s.user_id) {
      if (!user) {
        const err = new Error('This signing session belongs to an Unplug account. Sign in to continue.');
        err.statusCode = 401;
        throw err;
      }
      if (Number(s.user_id) !== Number(user.id)) {
        const err = new Error('That signing session belongs to another account.');
        err.statusCode = 403;
        throw err;
      }
    } else if (!s.guest_payment_allowed_at_signing) {
      const err = new Error('This agreement required an Unplug account for payment.');
      err.statusCode = 401;
      throw err;
    }
    return s;
  }

  // No immutable session exists yet: current policy applies to this NEW
  // before-sign payment session.
  if (agreement.payment_mode !== 'before_sign' || Number(agreement.amount) <= 0) {
    const err = new Error('This agreement does not require payment before signing.');
    err.statusCode = 400;
    throw err;
  }
  if (!user && !agreement.guest_payment_allowed) {
    const err = new Error('This agreement requires an Unplug account for payment.');
    err.statusCode = 401;
    throw err;
  }

  // For a signed-in member, reuse their newest unfinished session even if the
  // browser lost its token. For a guest there is no safe identity until the
  // first response gives them a token, so a no-token request starts fresh.
  if (user) {
    const existing = await client.query(
      `SELECT s.*
         FROM agreement_submissions s
        WHERE s.agreement_id = $1 AND s.user_id = $2
          AND s.signed_at IS NULL
          AND s.payment_mode_at_signing = 'before_sign'
          AND s.status IN ('started', 'ready_to_sign')
        ORDER BY s.started_at DESC, s.id DESC LIMIT 1`,
      [agreement.id, user.id]
    );
    if (existing.rowCount) return existing.rows[0];
  }

  const reference = await generateUnique({
    table: 'agreement_submissions', column: 'reference', prefix: 'AGR-', length: 10, client,
  });
  const signingToken = await generateUnique({
    table: 'agreement_submissions', column: 'signing_token', length: 32, client,
  });
  const created = await client.query(
    `INSERT INTO agreement_submissions
       (agreement_id, user_id, reference, signing_token, status, payment_status,
        agreement_version, amount_at_signing, payment_mode_at_signing,
        guest_payment_allowed_at_signing)
     SELECT id, $2, $3, $4, 'started', 'awaiting_payment', version, amount,
            payment_mode, guest_payment_allowed
       FROM agreement_forms
      WHERE id = $1
     RETURNING *`,
    [agreement.id, user ? user.id : null, reference, signingToken]
  );
  return created.rows[0];
}

// Public: tells the signing page exactly which payment path applies now.
// Historical/start-in-progress payment rules come from the submission snapshot
// instead and are intentionally not inferred from this endpoint.
router.get('/:slug/options', async (req, res, next) => {
  try {
    const agreement = await agreementBySlug(req.params.slug);
    if (!agreement) return res.status(404).json({ error: 'Agreement not found.' });
    const paid = Number(agreement.amount) > 0 && agreement.payment_mode !== 'none';
    res.json({
      slug: agreement.slug,
      title: agreement.title,
      open: activeNow(agreement),
      paid,
      amount: agreement.amount === null ? null : Number(agreement.amount),
      paymentMode: agreement.payment_mode,
      guestPaymentAllowed: paid ? agreement.guest_payment_allowed : false,
      accountRequiredForPayment: paid ? !agreement.guest_payment_allowed : false,
      liveMethods: paid ? ['eft'] : [],
    });
  } catch (err) { next(err); }
});

// Admin: option C switch. Kept in a dedicated endpoint so payment policy can be
// permissioned/audited independently of editing the legal wording itself.
router.patch('/admin/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const body = req.body || {};
    if (typeof body.guestPaymentAllowed !== 'boolean') {
      return res.status(400).json({ error: 'guestPaymentAllowed must be true or false.' });
    }
    const r = await pool.query(
      `UPDATE agreement_forms
          SET guest_payment_allowed = $2, updated_at = now()
        WHERE id = $1
        RETURNING id, slug, title, guest_payment_allowed`,
      [req.params.id, body.guestPaymentAllowed]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'Agreement not found.' });
    res.json({
      agreementId: r.rows[0].id,
      guestPaymentAllowed: r.rows[0].guest_payment_allowed,
      accountRequiredForPayment: !r.rows[0].guest_payment_allowed,
    });
  } catch (err) { next(err); }
});

// Start/resume a paid Agreement EFT. Works for both payment timings:
// * before_sign: creates/returns a provisional signing session first;
// * after_sign: points at the already-signed submission.
//
// Critical invariant: once a session/signature exists, its snapshotted amount,
// payment timing and guest policy survive later admin edits/closure/archive.
router.post('/:slug/start', publicSubmitLimiter, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body || {};
    const agreement = await agreementBySlug(req.params.slug, client);
    if (!agreement) return res.status(404).json({ error: 'Agreement not found.' });

    const requested = paymentSnapshotRequest(body);
    // Only a brand-new payment session depends on CURRENT open/payable state.
    // Existing before-sign tokens and already-signed after-sign submissions are
    // contractual snapshots and must remain payable after an admin edit.
    if (!requested.hasCredential) {
      if (!activeNow(agreement)) {
        return res.status(410).json({ error: 'This agreement is not currently open.' });
      }
      if (agreement.payment_mode !== 'before_sign' || Number(agreement.amount) <= 0) {
        return res.status(400).json({ error: 'This agreement does not require payment before signing.' });
      }
    }

    if (body.termsAccepted !== true) {
      return res.status(400).json({
        error: 'You must read and accept the current Unplug Terms & Conditions and Cancellation, Refund & Account Credit Policy before payment.',
      });
    }
    const method = String(body.method || 'eft').toLowerCase();
    if (method !== 'eft') {
      return res.status(400).json({ error: 'EFT is the only live payment method right now.' });
    }

    const member = req.user ? await memberIdentity(req.user.id, client) : null;
    if (req.user && !member) return res.status(401).json({ error: 'Your account could not be verified.' });

    await client.query('BEGIN');
    const submission = await authorisedSubmission({
      agreement, body, user: req.user || null, client,
    });

    // A session/signed record freezes its amount and guest policy. Never charge
    // the agreement's current amount if the contract was already started under
    // an earlier value.
    const amount = Number(submission.amount_at_signing);
    if (!Number.isFinite(amount) || amount <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This agreement snapshot has no payable amount.' });
    }

    // Member-owned submissions use the account identity. Guest submissions can
    // reuse the signed name/email in the after-sign flow, so an external signer
    // is not forced to type the same information twice.
    const isGuestSubmission = !submission.user_id;
    let payerName = member ? member.full_name : safeName(body.payerName) || safeName(submission.signer_name);
    let payerEmail = member ? member.email : String(body.payerEmail || submission.signer_email || '').trim().slice(0, 255);
    if (isGuestSubmission) {
      if (!payerName) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Your name is required for guest payment.' });
      }
      if (!validEmail(payerEmail)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'A valid email address is required for guest payment.' });
      }
      payerEmail = payerEmail.toLowerCase();
    }

    const existing = await paymentForSubmission(submission.id, client);
    if (existing) {
      await client.query('COMMIT');
      return res.status(200).json({
        existing: true,
        guest: isGuestSubmission,
        accountRequiredForPayment: !submission.guest_payment_allowed_at_signing,
        ...paymentResponse(existing, submission),
      });
    }

    const gatewayReference = await generateUnique({
      table: 'payments', column: 'gateway_reference', digits: true, client,
    });
    const p = await client.query(
      `INSERT INTO payments
         (user_id, guest_payer_name, guest_payer_email,
          amount, method, gateway_reference, status, linked_type, linked_id,
          terms_version, terms_accepted_at, terms_ip, terms_user_agent,
          credit_used, order_total)
       VALUES ($1,$2,$3,$4,'eft',$5,'pending','agreement_payment',$6,
               $7,now(),$8,$9,0,$4)
       RETURNING *`,
      [
        submission.user_id || null,
        isGuestSubmission ? payerName : null,
        isGuestSubmission ? payerEmail : null,
        amount,
        gatewayReference,
        submission.id,
        TERMS_VERSION,
        req.ip || null,
        req.get('user-agent') || null,
      ]
    );
    await client.query('COMMIT');

    return res.status(201).json({
      existing: false,
      guest: isGuestSubmission,
      accountRequiredForPayment: !submission.guest_payment_allowed_at_signing,
      ...paymentResponse(p.rows[0], submission),
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  } finally {
    client.release();
  }
});

// The secret signing token is the resume credential. Returns no payer name,
// email or bank details: just enough for the signing page to know whether the
// EFT was confirmed and the signature can proceed.
router.get('/:slug/session/:token', async (req, res, next) => {
  try {
    const r = await pool.query(
      `SELECT s.id, s.status, s.payment_status, s.payment_mode_at_signing,
              s.signing_token, p.status AS live_payment_status, p.gateway_reference
         FROM agreement_submissions s
         JOIN agreement_forms a ON a.id = s.agreement_id
         LEFT JOIN LATERAL (
           SELECT status, gateway_reference
             FROM payments
            WHERE linked_type='agreement_payment' AND linked_id=s.id
            ORDER BY created_at DESC, id DESC LIMIT 1
         ) p ON true
        WHERE LOWER(a.slug)=LOWER($1) AND s.signing_token=$2`,
      [req.params.slug, req.params.token]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'Signing/payment session not found.' });
    const row = r.rows[0];
    res.set('Cache-Control', 'no-store');
    res.json({
      submissionId: row.id,
      paymentStatus: row.live_payment_status || row.payment_status,
      readyToSign: (row.live_payment_status || row.payment_status) === 'confirmed',
      reference: row.gateway_reference || null,
    });
  } catch (err) { next(err); }
});

module.exports = router;
