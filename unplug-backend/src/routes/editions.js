const express = require('express');
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { getPagination, paginationMeta } = require('../utils/pagination');

const router = express.Router();

// GET /editions — public list, newest first. Includes the pdf_url so the
// frontend's "View Online" button can embed/link to it directly — viewing
// is always free, no login required.
router.get('/', async (req, res, next) => {
  try {
    const { page, limit, offset } = getPagination(req);

    const countResult = await pool.query('SELECT COUNT(*) FROM editions');

    const result = await pool.query(
      `SELECT id, issue_number, title, cover_image_url, pdf_url, download_price, published_at
       FROM editions ORDER BY issue_number DESC
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

// GET /editions/:id — single edition detail, same free-viewing info.
router.get('/:id', async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM editions WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Edition not found.' });
    }
    res.json({ edition: result.rows[0] });
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
    const purchase = await pool.query(
      `SELECT id FROM edition_purchases WHERE user_id = $1 AND edition_id = $2`,
      [req.user.id, req.params.id]
    );
    if (purchase.rows.length === 0) {
      return res.status(403).json({ error: 'You need to purchase this edition before downloading it.' });
    }
    const edition = await pool.query('SELECT pdf_url, title FROM editions WHERE id = $1', [req.params.id]);
    if (edition.rows.length === 0) {
      return res.status(404).json({ error: 'Edition not found.' });
    }
    res.json({ pdfUrl: edition.rows[0].pdf_url, title: edition.rows[0].title });
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
    const { issueNumber, title, coverImageUrl, pdfUrl, downloadPrice } = req.body;
    if (!issueNumber || !title || !pdfUrl) {
      return res.status(400).json({ error: 'issueNumber, title, and pdfUrl are required.' });
    }
    const result = await pool.query(
      `INSERT INTO editions (issue_number, title, cover_image_url, pdf_url, download_price)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [issueNumber, title, coverImageUrl || null, pdfUrl, downloadPrice != null ? downloadPrice : 50.00]
    );
    res.status(201).json({ edition: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
