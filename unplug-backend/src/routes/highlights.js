const express = require('express');
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// GET /highlights/active — public. Used by the homepage/article/directory
// pages to know what's currently boosted and should render with the
// "Highlighted" badge. A NULL start/end means "no restriction" on that side,
// so an admin highlight with no end date runs indefinitely. Ordered by the
// admin's chosen priority (lower number = shown first).
router.get('/active', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, target_type, target_id, start_date, end_date, admin_image_url, priority
       FROM highlights
       WHERE status = 'approved'
         AND (start_date IS NULL OR start_date <= CURRENT_DATE)
         AND (end_date IS NULL OR end_date >= CURRENT_DATE)
       ORDER BY priority ASC, id DESC`
    );
    res.json({ highlights: result.rows });
  } catch (err) {
    next(err);
  }
});

// ————————————————————————————————————————————————————————————————
// Admin: manually control which articles/profiles are highlighted, on what
// schedule, in what order, and with an optional cover image override. This is
// the editorial "Highlighted Articles" system — separate from the paid member
// highlight request below.

// GET /highlights/admin/all — every highlight (any status) with the target's
// title so the admin UI can list them.
router.get('/admin/all', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT h.id, h.target_type, h.target_id, h.status, h.start_date, h.end_date,
              h.priority, h.admin_image_url, h.is_admin, h.created_at,
              CASE WHEN h.target_type = 'article' THEN a.title ELSE p.display_name END AS target_title,
              CASE WHEN h.target_type = 'article' THEN a.banner_image_url ELSE p.feature_image_url END AS target_image
         FROM highlights h
         LEFT JOIN articles a ON h.target_type = 'article' AND a.id = h.target_id
         LEFT JOIN profiles p ON h.target_type = 'directory' AND p.id = h.target_id
        ORDER BY h.priority ASC, h.id DESC`
    );
    res.json({ highlights: result.rows });
  } catch (err) {
    next(err);
  }
});

function parseHighlightBody(body) {
  const targetType = ['article', 'directory'].includes(body.targetType) ? body.targetType : null;
  const targetId = Number(body.targetId);
  if (!targetType) return { error: 'targetType must be "article" or "directory".' };
  if (!Number.isInteger(targetId)) return { error: 'A valid targetId is required.' };
  const priority = Number.isInteger(Number(body.priority)) ? Number(body.priority) : 0;
  // Empty string / missing => NULL (no restriction). "No end date" = null endDate.
  const startDate = body.startDate ? String(body.startDate) : null;
  const endDate = body.endDate ? String(body.endDate) : null;
  const adminImageUrl = (body.imageUrl || body.adminImageUrl || '').trim() || null;
  return { targetType, targetId, priority, startDate, endDate, adminImageUrl };
}

// POST /highlights/admin — admin creates an approved highlight immediately
// (no payment), with explicit dates, priority and optional cover override.
router.post('/admin', requireRole('admin'), async (req, res, next) => {
  try {
    const v = parseHighlightBody(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    const table = v.targetType === 'article' ? 'articles' : 'profiles';
    const exists = await pool.query(`SELECT 1 FROM ${table} WHERE id = $1`, [v.targetId]);
    if (exists.rowCount === 0) return res.status(404).json({ error: `That ${v.targetType} does not exist.` });
    const result = await pool.query(
      `INSERT INTO highlights (target_type, target_id, status, start_date, end_date, priority, admin_image_url, is_admin)
       VALUES ($1, $2, 'approved', $3, $4, $5, $6, true) RETURNING *`,
      [v.targetType, v.targetId, v.startDate, v.endDate, v.priority, v.adminImageUrl]
    );
    res.status(201).json({ highlight: result.rows[0], message: 'Highlight created and live within its dates.' });
  } catch (err) {
    next(err);
  }
});

// PATCH /highlights/admin/:id — edit dates, priority, cover image, or toggle
// active/inactive via status (approved = active, rejected = hidden).
router.patch('/admin/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'A valid highlight id is required.' });
    const map = {
      startDate: 'start_date', endDate: 'end_date', priority: 'priority',
      imageUrl: 'admin_image_url', status: 'status',
    };
    const sets = [];
    const values = [];
    for (const [bodyKey, column] of Object.entries(map)) {
      if (req.body[bodyKey] === undefined) continue;
      let val = req.body[bodyKey];
      if (column === 'status' && !['approved', 'rejected', 'pending'].includes(val)) continue;
      if ((column === 'start_date' || column === 'end_date' || column === 'admin_image_url') && val === '') val = null;
      values.push(val);
      sets.push(`${column} = $${values.length}`);
    }
    if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update.' });
    values.push(id);
    const result = await pool.query(
      `UPDATE highlights SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'That highlight no longer exists.' });
    res.json({ highlight: result.rows[0], message: 'Saved — the change is live now.' });
  } catch (err) {
    next(err);
  }
});

// DELETE /highlights/admin/:id — remove a highlight entirely.
router.delete('/admin/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'A valid highlight id is required.' });
    const result = await pool.query('DELETE FROM highlights WHERE id = $1 RETURNING id', [id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'That highlight no longer exists.' });
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

// Homepage highlight packages. Mirrors HIGHLIGHT_PRICES in routes/payments.js,
// which is what actually gets charged — served from here so the dashboard shows
// the real prices instead of hardcoding its own copy.
const HIGHLIGHT_PACKAGES = {
  directory: [
    { durationDays: 7,  price: 100.00, name: '7-Day Homepage Highlight' },
    { durationDays: 14, price: 150.00, name: '14-Day Homepage Highlight' },
    { durationDays: 21, price: 200.00, name: '21-Day Homepage Highlight' },
    { durationDays: 28, price: 250.00, name: '28-Day Homepage Highlight' },
  ],
  article: [
    { durationDays: 7,  price: 150.00, name: '7-Day Article Highlight' },
    { durationDays: 14, price: 250.00, name: '14-Day Article Highlight' },
    { durationDays: 21, price: 300.00, name: '21-Day Article Highlight' },
    { durationDays: 28, price: 450.00, name: '28-Day Article Highlight' },
  ],
};

// GET /highlights/packages — public. The packages + prices for the buy form.
router.get('/packages', (req, res) => {
  res.json({ packages: HIGHLIGHT_PACKAGES });
});

// GET /highlights/mine — the member's own highlight promotions, at any status,
// so their dashboard can show what's pending payment / scheduled / live / done.
router.get('/mine', requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT h.id, h.target_type, h.target_id, h.duration_days, h.status,
              h.start_date, h.end_date, h.requested_start_date, h.is_admin,
              h.created_at,
              CASE WHEN h.target_type = 'article' THEN a.title ELSE p.display_name END AS target_title,
              CASE WHEN h.target_type = 'article' THEN a.banner_image_url ELSE p.feature_image_url END AS target_image,
              pay.amount AS amount_paid, pay.status AS payment_status,
              pay.gateway_reference AS payment_reference
         FROM highlights h
         LEFT JOIN articles a ON h.target_type = 'article'   AND a.id = h.target_id
         LEFT JOIN profiles p ON h.target_type = 'directory' AND p.id = h.target_id
         -- payments.linked_id has no FK, so this is matched on type + id.
         LEFT JOIN payments pay ON pay.linked_type = 'highlight' AND pay.linked_id = h.id
        WHERE (h.target_type = 'article'   AND a.author_user_id = $1)
           OR (h.target_type = 'directory' AND p.user_id = $1)
        ORDER BY h.created_at DESC`,
      [req.user.id]
    );
    // Derive the display status the dashboard shows, so the same rules live in
    // one place rather than being re-guessed in the browser.
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    const highlights = result.rows.map((h) => {
      const start = h.start_date ? new Date(h.start_date) : null;
      const end = h.end_date ? new Date(h.end_date) : null;
      let label;
      if (h.status === 'rejected') label = 'Cancelled';
      else if (h.status === 'awaiting_payment') label = 'Pending payment';
      else if (h.status === 'pending') label = 'Awaiting approval';
      else if (start && start > today) label = 'Scheduled';
      else if (end && end < today) label = 'Completed';
      else label = 'Active';
      const daysLeft = (label === 'Active' && end)
        ? Math.max(0, Math.ceil((end - today) / 86400000)) : null;
      return { ...h, statusLabel: label, daysLeft };
    });
    res.json({ highlights });
  } catch (err) { next(err); }
});

// POST /highlights — member requests a highlight on their own article or
// Directory profile. Ownership of the target is checked inline below.
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { targetType, targetId, durationDays, requestedStartDate } = req.body;
    if (!['article', 'directory'].includes(targetType)) {
      return res.status(400).json({ error: 'targetType must be "article" or "directory".' });
    }
    if (![7, 14, 21, 28].includes(durationDays)) {
      return res.status(400).json({ error: 'durationDays must be one of: 7, 14, 21, 28.' });
    }
    // Optional future start date. The END date is always derived from the paid
    // duration (see applyPaymentEffect), so a member can pick when the run
    // begins but can never buy 7 days and get 30.
    let startDate = null;
    if (requestedStartDate) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedStartDate)) {
        return res.status(400).json({ error: 'requestedStartDate must be a date in YYYY-MM-DD format.' });
      }
      const today = new Date(); today.setUTCHours(0, 0, 0, 0);
      const wanted = new Date(requestedStartDate + 'T00:00:00Z');
      if (Number.isNaN(wanted.getTime())) {
        return res.status(400).json({ error: 'That start date is not a valid date.' });
      }
      if (wanted < today) {
        return res.status(400).json({ error: 'The start date cannot be in the past.' });
      }
      startDate = requestedStartDate;
    }

    const ownerTable = targetType === 'article' ? 'articles' : 'profiles';
    const ownerColumn = targetType === 'article' ? 'author_user_id' : 'user_id';
    const ownerCheck = await pool.query(`SELECT ${ownerColumn} AS owner_id FROM ${ownerTable} WHERE id = $1`, [targetId]);
    if (ownerCheck.rows.length === 0) {
      return res.status(404).json({ error: `${targetType} not found.` });
    }
    if (ownerCheck.rows[0].owner_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'You can only highlight your own content.' });
    }

    const result = await pool.query(
      `INSERT INTO highlights (target_type, target_id, duration_days, requested_start_date)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [targetType, targetId, durationDays, startDate]
    );

    res.status(201).json({
      highlight: result.rows[0],
      message: 'Highlight request created — call POST /payments/initiate with linkedType "highlight" and this highlight\'s id to proceed.',
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
