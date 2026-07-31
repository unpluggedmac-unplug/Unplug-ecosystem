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

// PATCH /editions/:id — admin edits an edition.
//
// Replacing the PDF is allowed and deliberately does NOT affect existing
// purchases: a purchase points at the edition, not at a file path, so buyers
// keep their access and simply get the corrected file.
router.patch('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = await pool.query('SELECT id FROM editions WHERE id = $1', [id]);
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
          cover_image_url, pdf_url, download_price, publication_date, status, display_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        issueNumber, title.slice(0, 255),
        (b.editionNumber || '').trim().slice(0, 40) || null,
        (b.month || '').trim().slice(0, 20) || null,
        b.year ? Number(b.year) : null,
        (b.description || '').trim() || null,
        b.coverImageUrl || null, pdfUrl,
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
