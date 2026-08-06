const express = require('express');
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { getPagination, paginationMeta } = require('../utils/pagination');
const { publicSubmitLimiter } = require('../middleware/rateLimit');
const { sendEmail } = require('../utils/email');
const { logActivity } = require('./activityLog');
const { eftInstructions } = require('../utils/eftDetails');
const {
  generateReference, generateToken, referenceMatches, normaliseEmail, isValidEmail,
} = require('../utils/editionAccess');

const router = express.Router();

// Where the download-claim link in the approval email should point. Same
// SITE_URL convention the sign-in emails use, so it follows the domain.
const SITE_URL = (process.env.SITE_URL || 'https://www.unplugnews.com').replace(/\/$/, '');

// GET /editions — public list, newest first. Includes the pdf_url so the
// frontend's "View Online" button can embed/link to it directly — viewing
// is always free, no login required.
router.get('/', async (req, res, next) => {
  try {
    const { page, limit, offset } = getPagination(req);

    // Public list: published editions only. Draft, unpublished and archived
    // editions stay visible to admin but never appear on the site.
    const countResult = await pool.query(
      `SELECT COUNT(*) FROM editions WHERE status = 'published'`
    );

    const result = await pool.query(
      `SELECT id, issue_number, edition_number, title, month, year, description,
              cover_image_url, pdf_url, download_price, publication_date, published_at
       FROM editions
       WHERE status = 'published'
       -- Newest first. display_order lets an admin pin a specific edition to
       -- the top; publication_date is the natural order otherwise.
       ORDER BY display_order DESC, publication_date DESC NULLS LAST, issue_number DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    res.json({
      editions: result.rows,
      pagination: paginationMeta(page, limit, parseInt(countResult.rows[0].count, 10)),
    });
  } catch (err) {
    next(err);
  }
});

// GET /editions/calendar — public. The upcoming "Save the Date" days shown
// on the Editions page calendar. Only today-and-future entries (past ones
// drop off automatically). Registered BEFORE /:id so "calendar" isn't
// mistaken for an edition id.
router.get('/calendar', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, event_date, title, description
       FROM edition_calendar
       WHERE event_date >= CURRENT_DATE
       ORDER BY event_date ASC`
    );
    res.json({ dates: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /editions/calendar — admin marks a day as a "Save the Date".
router.post('/calendar', requireRole('admin'), async (req, res, next) => {
  try {
    const { eventDate, title, description } = req.body;
    if (!eventDate || !title) {
      return res.status(400).json({ error: 'eventDate and title are required.' });
    }
    const result = await pool.query(
      `INSERT INTO edition_calendar (event_date, title, description)
       VALUES ($1, $2, $3) RETURNING *`,
      [eventDate, title, description || null]
    );
    res.status(201).json({ date: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// PATCH /editions/calendar/:id — admin edits a marked day. Only the fields
// sent are changed, so editing just the description doesn't wipe the date.
router.patch('/calendar/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const sets = [];
    const values = [];
    if (req.body.eventDate !== undefined) {
      if (!req.body.eventDate) return res.status(400).json({ error: 'A date cannot be blank.' });
      values.push(req.body.eventDate); sets.push(`event_date = $${values.length}`);
    }
    if (req.body.title !== undefined) {
      if (!String(req.body.title).trim()) return res.status(400).json({ error: 'A title cannot be blank.' });
      values.push(String(req.body.title).trim()); sets.push(`title = $${values.length}`);
    }
    if (req.body.description !== undefined) {
      values.push(String(req.body.description || '').trim() || null); sets.push(`description = $${values.length}`);
    }
    if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update.' });

    values.push(req.params.id);
    const result = await pool.query(
      `UPDATE edition_calendar SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Marked date not found.' });
    res.json({ date: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /editions/calendar/:id — admin removes a marked day.
router.delete('/calendar/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      'DELETE FROM edition_calendar WHERE id = $1 RETURNING id',
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Marked date not found.' });
    }
    res.json({ message: 'Removed.' });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Paid downloads: buy (online or EFT), claim with email + reference, download
// once.
//
// Reading an edition online is free and needs none of this. Everything below
// exists so that the downloadable PDF is only handed to the person who paid
// for it, once.
// ---------------------------------------------------------------------------

// POST /editions/:id/purchase — public. Starts a purchase. Works signed in or
// not; an email address is what the download is tied to either way.
//
// The PRICE IS READ FROM THE EDITION, never from the request. A posted amount
// would let anyone buy a R50 edition for R1.
router.post('/:id/purchase', publicSubmitLimiter, async (req, res, next) => {
  try {
    const edition = await pool.query(
      `SELECT id, title, download_price, status FROM editions WHERE id = $1`, [req.params.id]
    );
    if (edition.rows.length === 0 || edition.rows[0].status !== 'published') {
      return res.status(404).json({ error: 'This edition is currently unavailable.' });
    }

    const email = normaliseEmail(req.body.email || (req.user && req.user.email));
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Enter a valid email address — your download is linked to it.' });
    }
    const method = req.body.method === 'eft' ? 'eft' : 'online';
    const amount = Number(edition.rows[0].download_price);
    const reference = await generateReference();

    const result = await pool.query(
      `INSERT INTO edition_purchases
         (user_id, edition_id, customer_email, customer_name, amount,
          payment_method, payment_status, download_reference)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, download_reference`,
      [
        req.user ? req.user.id : null, edition.rows[0].id, email,
        (req.body.name || '').trim().slice(0, 160) || null, amount, method,
        // EFT waits for the admin to confirm the money arrived. Online waits
        // for the payment provider. Neither grants a download yet.
        method === 'eft' ? 'awaiting_eft' : 'awaiting_payment',
        reference,
      ]
    );

    res.status(201).json({
      purchaseId: result.rows[0].id,
      reference: result.rows[0].download_reference,
      amount,
      method,
      editionTitle: edition.rows[0].title,
      // For online, the frontend sends the buyer to the existing checkout with
      // these — no second payment system.
      linkedType: 'edition_download',
      linkedId: edition.rows[0].id,
      message: method === 'eft'
        ? 'Use this reference on your EFT. Once we confirm the payment we will email your download link.'
        : 'Continue to payment to unlock your download.',
      // Same banking details the rest of the site quotes — one shared source,
      // so they can never drift apart.
      instructions: method === 'eft'
        ? eftInstructions(result.rows[0].download_reference,
            'Make a standard bank EFT to the account above using this exact reference. Once we confirm the payment we will email your download link. Keep this reference — you need it together with your email address to start the download.')
        : null,
    });
  } catch (err) {
    next(err);
  }
});

// POST /editions/download/claim — public. Exchanges email + reference for a
// one-time download link.
//
// Rate limited: without it, the 10-character reference could be attacked by
// simply trying codes.
router.post('/download/claim', publicSubmitLimiter, async (req, res, next) => {
  try {
    const email = normaliseEmail(req.body.email);
    const submittedRef = String(req.body.reference || '').trim().toUpperCase();
    if (!isValidEmail(email) || !submittedRef) {
      return res.status(400).json({ error: 'Enter the email address you bought with and your reference code.' });
    }

    // Look up by reference AND email together. A reference alone is not enough
    // — that is what stops a forwarded code working for someone else.
    const found = await pool.query(
      `SELECT ep.*, e.title AS edition_title
         FROM edition_purchases ep
         JOIN editions e ON e.id = ep.edition_id
        WHERE ep.download_reference = $1 AND lower(ep.customer_email) = $2`,
      [submittedRef, email]
    );

    if (found.rowCount === 0) {
      // Deliberately one message for "no such reference" and "wrong email":
      // telling them apart would confirm to a stranger that a reference is
      // real and only the email is missing.
      return res.status(404).json({
        error: 'We could not match that reference code to that email address. Please check both and try again.',
      });
    }
    const p = found.rows[0];
    if (!referenceMatches(submittedRef, p.download_reference)) {
      return res.status(404).json({ error: 'We could not match that reference code to that email address.' });
    }

    if (p.payment_status === 'rejected') {
      return res.status(403).json({ error: 'Your payment has not been approved. Please contact us if you believe this is incorrect.' });
    }
    if (p.payment_status !== 'approved') {
      return res.status(403).json({
        error: p.payment_method === 'eft'
          ? 'Your EFT payment is still awaiting approval. We will email you as soon as it is confirmed.'
          : 'Your payment has not been completed yet.',
      });
    }
    if (p.download_status === 'revoked') {
      return res.status(403).json({ error: 'This download is no longer available. Please contact us.' });
    }
    if (p.download_count >= 1 || p.download_status === 'used') {
      return res.status(410).json({ error: 'This edition download has already been used.' });
    }

    // Mint the token at claim time rather than at purchase, so a token only
    // exists once access is genuinely due.
    let token = p.download_token;
    if (!token) {
      token = generateToken();
      await pool.query(
        'UPDATE edition_purchases SET download_token = $1, updated_at = now() WHERE id = $2',
        [token, p.id]
      );
    }
    res.json({
      downloadPath: `/editions/download/${token}`,
      editionTitle: p.edition_title,
      message: 'Your download is ready. It can be used once.',
    });
  } catch (err) {
    next(err);
  }
});

// GET /editions/download/:token — the actual file.
//
// The PDF is streamed THROUGH this endpoint. The stored file URL is never sent
// to the browser, so there is no permanent public link to pass around.
//
// Single use is enforced by a conditional UPDATE, not by reading then writing:
// two clicks at the same moment both run
//   UPDATE ... SET download_count = 1 WHERE id = $1 AND download_count = 0
// and the database lets exactly one of them match.
router.get('/download/:token', async (req, res, next) => {
  const token = String(req.params.token || '');
  let claimed = null;
  try {
    const found = await pool.query(
      `SELECT ep.id, ep.edition_id, ep.payment_status, ep.download_status, ep.download_count,
              e.pdf_url, e.download_pdf_url, e.title
         FROM edition_purchases ep
         JOIN editions e ON e.id = ep.edition_id
        WHERE ep.download_token = $1`,
      [token]
    );
    if (found.rowCount === 0) return res.status(404).json({ error: 'This download link is not valid.' });
    const p = found.rows[0];
    if (p.payment_status !== 'approved') return res.status(403).json({ error: 'This purchase is not approved.' });
    // The private, full-quality file if the admin uploaded one separately;
    // falls back to the free-view file for editions published before
    // 094_edition_download_pdf.sql (or where an admin never uploaded a
    // separate download copy) — see that migration for the full reasoning.
    const fileUrl = p.download_pdf_url || p.pdf_url;
    if (!fileUrl) return res.status(404).json({ error: 'This edition is currently unavailable.' });

    const reserve = await pool.query(
      `UPDATE edition_purchases
          SET download_count = 1, download_status = 'used', updated_at = now()
        WHERE id = $1 AND download_count = 0 AND download_status = 'available'
        RETURNING id`,
      [p.id]
    );
    if (reserve.rowCount === 0) {
      return res.status(410).json({ error: 'This edition download has already been used.' });
    }
    claimed = p;

    // The service-role key is included unconditionally — required for the
    // private download_pdf_url, and harmless on the public pdf_url
    // fallback (a public bucket object ignores auth headers it doesn't need).
    const { SUPABASE_SERVICE_KEY } = process.env;
    const upstream = await fetch(fileUrl, SUPABASE_SERVICE_KEY
      ? { headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, apikey: SUPABASE_SERVICE_KEY } }
      : undefined);
    if (!upstream.ok || !upstream.body) throw new Error(`Could not fetch the edition file (${upstream.status})`);

    const safeName = (p.title || 'unplug-edition').replace(/[^a-z0-9\- ]/gi, '').trim() || 'unplug-edition';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.pdf"`);
    const len = upstream.headers.get('content-length');
    if (len) res.setHeader('Content-Length', len);

    const { Readable } = require('stream');
    const stream = Readable.fromWeb(upstream.body);

    // Only count the download as spent once the file actually finished
    // sending. If the transfer dies halfway the hold is released, so a dropped
    // connection doesn't cost the customer the copy they paid for.
    let settled = false;
    const release = async (outcome) => {
      if (settled) return;
      settled = true;
      if (outcome === 'delivered') {
        await pool.query(
          `INSERT INTO edition_downloads (purchase_id, edition_id, outcome) VALUES ($1, $2, 'delivered')`,
          [p.id, p.edition_id]
        ).catch(() => {});
        return;
      }
      await pool.query(
        `UPDATE edition_purchases
            SET download_count = 0, download_status = 'available', updated_at = now()
          WHERE id = $1`, [p.id]
      ).catch(() => {});
      await pool.query(
        `INSERT INTO edition_downloads (purchase_id, edition_id, outcome) VALUES ($1, $2, 'failed')`,
        [p.id, p.edition_id]
      ).catch(() => {});
    };

    res.on('close', () => { if (!res.writableFinished) release('failed'); });
    res.on('finish', () => release('delivered'));
    stream.on('error', () => { release('failed'); res.destroy(); });
    stream.pipe(res);
  } catch (err) {
    // Anything failing before/while starting the transfer must not consume the
    // customer's single download.
    if (claimed) {
      await pool.query(
        `UPDATE edition_purchases SET download_count = 0, download_status = 'available', updated_at = now()
          WHERE id = $1`, [claimed.id]
      ).catch(() => {});
    }
    if (!res.headersSent) return res.status(502).json({ error: 'The edition file could not be delivered. Please try again.' });
    next(err);
  }
});

// GET /editions/latest — public. The newest published edition, for the
// homepage "Latest Edition" panel. Registered BEFORE /:id so "latest" isn't
// read as an edition id.
//
// This is what keeps the homepage self-updating: it asks the database which
// edition is newest rather than naming one, so publishing a new edition
// changes the homepage with no code change.
router.get('/latest', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, issue_number, edition_number, title, month, year, description,
              cover_image_url, pdf_url, download_price, publication_date, published_at
         FROM editions
        WHERE status = 'published'
        ORDER BY display_order DESC, publication_date DESC NULLS LAST, issue_number DESC
        LIMIT 1`
    );
    // Not an error — a site with no published edition yet just hides the panel.
    res.json({ edition: result.rows[0] || null });
  } catch (err) {
    next(err);
  }
});

// GET /editions/admin/all — admin list: every edition whatever its status,
// plus how many people have bought each one (which decides whether it can be
// safely deleted). Three segments keeps it clear of /:id.
router.get('/admin/all', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT e.*, COUNT(ep.id)::int AS purchase_count
         FROM editions e
         LEFT JOIN edition_purchases ep ON ep.edition_id = e.id
        GROUP BY e.id
        ORDER BY e.publication_date DESC NULLS LAST, e.issue_number DESC`
    );
    res.json({ editions: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /editions/admin/purchases — admin list of every edition purchase, so
// EFT payments can be matched against the bank statement by reference.
// GET /editions/my-purchases — the signed-in member's own edition purchases.
//
// Matched on the account id OR the email the purchase was made with: someone
// can buy as a guest and register later with the same address, and it would be
// strange for the purchase they just made not to appear.
//
// Returns the reference code, which is the customer's own credential for their
// download — but never the download token or the PDF url, so this list can't
// become a way around the single-use gate.
router.get('/my-purchases', requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT ep.id, ep.amount, ep.payment_method, ep.payment_status,
              ep.download_reference, ep.download_count, ep.download_status,
              ep.created_at, ep.approved_at,
              e.id AS edition_id, e.title AS edition_title, e.month, e.year,
              e.cover_image_url
         FROM edition_purchases ep
         JOIN editions e ON e.id = ep.edition_id
        WHERE ep.user_id = $1 OR lower(ep.customer_email) = lower($2)
        ORDER BY ep.created_at DESC`,
      [req.user.id, req.user.email || '']
    );

    res.json({
      purchases: result.rows.map((p) => {
        const used = p.download_count >= 1 || p.download_status === 'used';
        let statusLabel;
        if (p.payment_status === 'rejected') statusLabel = 'Payment not approved';
        else if (p.payment_status === 'awaiting_eft') statusLabel = 'Awaiting your EFT';
        else if (p.payment_status === 'pending_approval') statusLabel = 'Awaiting approval';
        else if (p.payment_status !== 'approved') statusLabel = 'Awaiting payment';
        else statusLabel = used ? 'Downloaded' : 'Ready to download';
        return {
          ...p,
          amount: Number(p.amount),
          statusLabel,
          // Whether the Download button should be offered at all.
          canDownload: p.payment_status === 'approved' && !used,
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/admin/purchases', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT ep.id, ep.customer_email, ep.customer_name, ep.amount, ep.payment_method,
              ep.payment_status, ep.download_reference, ep.download_count, ep.download_status,
              ep.approved_at, ep.created_at, ep.rejected_reason,
              e.title AS edition_title, u.email AS account_email
         FROM edition_purchases ep
         LEFT JOIN editions e ON e.id = ep.edition_id
         LEFT JOIN users u ON u.id = ep.user_id
        ORDER BY ep.created_at DESC
        LIMIT 300`
    );
    res.json({ purchases: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /editions/admin/purchases/:id/approve — admin confirms the EFT landed.
//
// This is the only thing that turns a pending purchase into a usable download,
// and it is admin-only: a customer can never approve their own payment.
router.post('/admin/purchases/:id/approve', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    // Conditional UPDATE so approving twice can't re-send the email or reset a
    // download the customer has already used.
    const result = await pool.query(
      `UPDATE edition_purchases
          SET payment_status = 'approved', approved_at = now(), approved_by = $2, updated_at = now()
        WHERE id = $1 AND payment_status IN ('awaiting_eft', 'pending_approval', 'awaiting_payment')
        RETURNING id, customer_email, download_reference, edition_id`,
      [id, req.user.id]
    );
    if (result.rowCount === 0) {
      return res.status(409).json({ error: 'That purchase is not awaiting approval (it may already be approved).' });
    }
    const p = result.rows[0];
    const edition = await pool.query('SELECT title FROM editions WHERE id = $1', [p.edition_id]);
    const title = edition.rows[0] ? edition.rows[0].title : 'your edition';

    await logActivity(req.user.id, 'edition_purchase_approved',
      `Approved edition download ${p.download_reference} for ${p.customer_email}`).catch(() => {});

    // The approval email is sent ONLY here, after approval — never earlier.
    let emailed = false;
    let emailError = null;
    try {
      const sent = await sendEmail({
        to: p.customer_email,
        subject: 'Your Unplug Magazine edition download is ready',
        text: [
          'Hello,',
          '',
          `Your payment for "${title}" has been approved.`,
          '',
          'You can now download your copy here:',
          `${SITE_URL}/unplug-magazine?p=editions&claim=1`,
          '',
          `Your reference code is: ${p.download_reference}`,
          '',
          'Enter that code together with this email address to start your download.',
          'Your download can be used once, and is linked to this email address, so please keep the code safe.',
          '',
          'Thank you for supporting Unplug Magazine.',
        ].join('\n'),
      });
      // sendEmail does NOT throw when no provider is configured — it logs the
      // message and returns { simulated: true }. Reporting that as "emailed"
      // would tell the admin the customer had their download link when nobody
      // sent one, so treat it as a failure the admin has to act on.
      if (sent && sent.simulated) {
        emailed = false;
        emailError = 'no email provider is configured, so nothing was actually sent';
      } else {
        emailed = true;
      }
    } catch (e) {
      // The approval itself has already happened and must stand — the customer
      // has paid. Report the email failure so the admin can pass the reference
      // on by hand rather than assuming it was delivered.
      emailError = e.message;
      console.error('Edition approval email failed:', e.message);
    }

    res.json({
      approved: true, emailed, emailError,
      message: emailed
        ? 'Approved — the download link and reference have been emailed to the customer.'
        : `Approved, but the email could not be sent (${emailError}). Send the customer their reference code (${p.download_reference}) yourself.`,
    });
  } catch (err) {
    next(err);
  }
});

// POST /editions/admin/purchases/:id/reject — admin marks a payment as not
// received. No email is sent; nothing is deleted, so the record stays for
// the financial history.
router.post('/admin/purchases/:id/reject', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE edition_purchases
          SET payment_status = 'rejected', rejected_reason = $2, updated_at = now()
        WHERE id = $1 AND payment_status <> 'approved'
        RETURNING id, download_reference, customer_email`,
      [Number(req.params.id), (req.body.reason || '').trim().slice(0, 500) || null]
    );
    if (result.rowCount === 0) {
      return res.status(409).json({ error: 'That purchase cannot be rejected (an approved purchase must not be reversed here).' });
    }
    await logActivity(req.user.id, 'edition_purchase_rejected',
      `Rejected edition download ${result.rows[0].download_reference} for ${result.rows[0].customer_email}`).catch(() => {});
    res.json({ rejected: true });
  } catch (err) {
    next(err);
  }
});

// PATCH /editions/:id — admin edits an edition.
//
// Replacing the PDF is allowed and deliberately does NOT affect existing
// purchases: a purchase points at the edition, not at a file path, so buyers
// keep their access and simply get the corrected file.
router.patch('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = await pool.query('SELECT id, pdf_url, download_pdf_url FROM editions WHERE id = $1', [id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Edition not found.' });

    const b = req.body;
    if (b.status !== undefined && !['draft', 'published', 'unpublished', 'archived'].includes(b.status)) {
      return res.status(400).json({ error: 'Status must be draft, published, unpublished or archived.' });
    }
    if (b.title !== undefined && !String(b.title).trim()) {
      return res.status(400).json({ error: 'Give the edition a title.' });
    }
    if (b.downloadPrice !== undefined && (isNaN(Number(b.downloadPrice)) || Number(b.downloadPrice) < 0)) {
      return res.status(400).json({ error: 'Download price must be zero or more.' });
    }

    // Only the fields actually sent are touched, so a partial save can't blank
    // the rest of the record.
    const sets = [];
    const vals = [];
    const put = (col, val) => { vals.push(val); sets.push(`${col} = $${vals.length}`); };
    if (b.title !== undefined) put('title', String(b.title).trim().slice(0, 255));
    if (b.editionNumber !== undefined) put('edition_number', String(b.editionNumber).trim().slice(0, 40) || null);
    if (b.month !== undefined) put('month', String(b.month).trim().slice(0, 20) || null);
    if (b.year !== undefined) put('year', b.year === null || b.year === '' ? null : Number(b.year));
    if (b.description !== undefined) put('description', String(b.description || '').trim() || null);
    if (b.publicationDate !== undefined) put('publication_date', b.publicationDate || null);
    if (b.coverImageUrl !== undefined) put('cover_image_url', b.coverImageUrl || null);
    if (b.pdfUrl !== undefined && b.pdfUrl) put('pdf_url', b.pdfUrl);
    // The private, full-quality file behind the paid single-use download —
    // separate from pdf_url (free "View Online"), see 094_edition_download_pdf.sql.
    // Explicitly clearable (empty string) so an admin can fall back to
    // pdf_url again without needing a workaround.
    if (b.downloadPdfUrl !== undefined) put('download_pdf_url', b.downloadPdfUrl || null);
    if (b.downloadPrice !== undefined) put('download_price', Number(b.downloadPrice));
    if (b.status !== undefined) put('status', b.status);
    if (b.displayOrder !== undefined) put('display_order', Number(b.displayOrder) || 0);
    if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update.' });
    sets.push('updated_at = now()');

    vals.push(id);
    const result = await pool.query(
      `UPDATE editions SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`,
      vals
    );

    // Keep a record of the file that was replaced. Overwriting pdf_url would
    // otherwise erase the only reference to it, even though the file is still
    // in storage and may be what earlier buyers actually received.
    const oldPdf = existing.rows[0].pdf_url;
    if (b.pdfUrl && oldPdf && b.pdfUrl !== oldPdf) {
      await pool.query(
        `INSERT INTO edition_pdf_versions (edition_id, pdf_url, replaced_by) VALUES ($1, $2, $3)`,
        [id, oldPdf, req.user.id]
      ).catch((e) => console.error('Could not record replaced edition PDF:', e.message));
    }

    res.json({ edition: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /editions/:id — admin removes an edition.
//
// Refused once anyone has bought it. edition_purchases CASCADEs from editions
// and its rows carry payment_id, so deleting a purchased edition would erase
// the customer's proof of purchase and orphan the payment. Archive instead:
// that hides it from the site and keeps every record.
router.delete('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = await pool.query('SELECT id FROM editions WHERE id = $1', [id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Edition not found.' });

    const bought = await pool.query(
      'SELECT COUNT(*)::int AS n FROM edition_purchases WHERE edition_id = $1', [id]
    );
    if (bought.rows[0].n > 0) {
      return res.status(409).json({
        error: `${bought.rows[0].n} ${bought.rows[0].n === 1 ? 'person has' : 'people have'} bought this edition. Deleting it would erase their purchase, so set it to Archived instead — that takes it off the site and keeps the records.`,
      });
    }

    await pool.query('DELETE FROM editions WHERE id = $1', [id]);
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

// GET /editions/:id — single edition detail, same free-viewing info. Public
// (no auth), so download_pdf_url — the private single-use download file —
// is stripped before responding, same as it's never selected in the other
// public routes above.
router.get('/:id', async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM editions WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Edition not found.' });
    }
    const edition = result.rows[0];
    delete edition.download_pdf_url;
    res.json({ edition });
  } catch (err) {
    next(err);
  }
});

// GET /editions/:id/download — only returns the file link if this user
// has actually paid for it (checked against edition_purchases). This is
// the real gate — the Download button on the frontend should call this,
// not just link to the PDF directly, or the R50 charge is meaningless.
//
// NOTE (be upfront about this): once someone has a legitimate download
// link, nothing stops them from re-sharing that file — that's true of
// any downloadable PDF anywhere, not something unique to this system. If
// stronger protection matters later (watermarking each buyer's copy with
// their name/email, expiring links, etc.), that's a follow-up feature,
// not something built here.
router.get('/:id/download', requireAuth, async (req, res, next) => {
  try {
    // A signed-in buyer shouldn't have to type their reference back in, so
    // this finds their unused approved purchase for them — but it returns a
    // download PATH, never the stored file URL, so this route goes through the
    // same single-use gate as everyone else rather than around it.
    const purchase = await pool.query(
      `SELECT id, download_token, download_count, download_status
         FROM edition_purchases
        WHERE user_id = $1 AND edition_id = $2 AND payment_status = 'approved'
        ORDER BY (download_status = 'available' AND download_count = 0) DESC, created_at DESC
        LIMIT 1`,
      [req.user.id, req.params.id]
    );
    if (purchase.rows.length === 0) {
      return res.status(403).json({ error: 'You need to purchase this edition before downloading it.' });
    }
    const p = purchase.rows[0];
    if (p.download_count >= 1 || p.download_status !== 'available') {
      return res.status(410).json({ error: 'This edition download has already been used.' });
    }

    const edition = await pool.query('SELECT title FROM editions WHERE id = $1', [req.params.id]);
    if (edition.rows.length === 0) {
      return res.status(404).json({ error: 'Edition not found.' });
    }

    let token = p.download_token;
    if (!token) {
      token = generateToken();
      await pool.query(
        'UPDATE edition_purchases SET download_token = $1, updated_at = now() WHERE id = $2',
        [token, p.id]
      );
    }
    res.json({ downloadPath: `/editions/download/${token}`, title: edition.rows[0].title });
  } catch (err) {
    next(err);
  }
});

// POST /editions/:id/purchase-download — member starts paying for the
// download. Call POST /payments/initiate next with linkedType
// "edition_download" and this edition's id — payment confirmation
// automatically creates the edition_purchases row (see applyPaymentEffect
// in payments.js), unlocking GET /editions/:id/download above.
router.post('/:id/purchase-download', requireAuth, async (req, res, next) => {
  try {
    const edition = await pool.query('SELECT id, download_price FROM editions WHERE id = $1', [req.params.id]);
    if (edition.rows.length === 0) {
      return res.status(404).json({ error: 'Edition not found.' });
    }

    const alreadyOwned = await pool.query(
      `SELECT id FROM edition_purchases WHERE user_id = $1 AND edition_id = $2`,
      [req.user.id, req.params.id]
    );
    if (alreadyOwned.rows.length > 0) {
      return res.status(409).json({ error: 'You already own this edition — call GET /editions/:id/download directly.' });
    }

    res.status(200).json({
      message: `Call POST /payments/initiate with linkedType "edition_download" and linkedId ${req.params.id} (R${Number(edition.rows[0].download_price).toFixed(2)}) to unlock the download.`,
    });
  } catch (err) {
    next(err);
  }
});

// POST /admin/editions — admin uploads a new edition. pdfUrl typically
// comes from POST /uploads first (or wherever the owner hosts their PDF).
router.post('/', requireRole('admin'), async (req, res, next) => {
  try {
    const b = req.body;
    const title = (b.title || '').trim();
    const pdfUrl = (b.pdfUrl || '').trim();
    if (!title || !pdfUrl) {
      return res.status(400).json({ error: 'A title and an uploaded PDF are required.' });
    }
    if (b.status !== undefined && !['draft', 'published', 'unpublished', 'archived'].includes(b.status)) {
      return res.status(400).json({ error: 'Status must be draft, published, unpublished or archived.' });
    }
    if (b.downloadPrice != null && (isNaN(Number(b.downloadPrice)) || Number(b.downloadPrice) < 0)) {
      return res.status(400).json({ error: 'Download price must be zero or more.' });
    }

    // issue_number is NOT NULL UNIQUE from the original schema but is an
    // internal counter, not something an admin should have to think about —
    // default it to the next one up.
    let issueNumber = b.issueNumber != null && b.issueNumber !== '' ? Number(b.issueNumber) : null;
    if (issueNumber == null) {
      const max = await pool.query('SELECT COALESCE(MAX(issue_number), 0) AS m FROM editions');
      issueNumber = Number(max.rows[0].m) + 1;
    }

    const result = await pool.query(
      `INSERT INTO editions
         (issue_number, title, edition_number, month, year, description,
          cover_image_url, pdf_url, download_pdf_url, download_price, publication_date, status, display_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [
        issueNumber, title.slice(0, 255),
        (b.editionNumber || '').trim().slice(0, 40) || null,
        (b.month || '').trim().slice(0, 20) || null,
        b.year ? Number(b.year) : null,
        (b.description || '').trim() || null,
        b.coverImageUrl || null, pdfUrl,
        (b.downloadPdfUrl || '').trim() || null,
        b.downloadPrice != null ? Number(b.downloadPrice) : 50.00,
        b.publicationDate || null,
        b.status || 'published',
        Number(b.displayOrder) || 0,
      ]
    );
    res.status(201).json({ edition: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'An edition with that issue number already exists.' });
    }
    next(err);
  }
});

module.exports = router;
