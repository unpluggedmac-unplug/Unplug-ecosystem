const express = require('express');
const pool = require('../db');
const { requireAuth, requireOwnerOrAdmin } = require('../middleware/auth');
const { getPagination, paginationMeta } = require('../utils/pagination');

const router = express.Router();

async function getInvestorOwnerId(req) {
  const result = await pool.query('SELECT user_id FROM investors WHERE id = $1', [req.params.id]);
  if (result.rows.length === 0) return null;
  return result.rows[0].user_id;
}

// GET /investors — public, approved only.
router.get('/', async (req, res, next) => {
  try {
    const { page, limit, offset } = getPagination(req);

    const countResult = await pool.query(`SELECT COUNT(*) FROM investors WHERE status = 'approved'`);

    const result = await pool.query(
      `SELECT id, name, about, contact_email, contact_phone, contact_website
       FROM investors
       WHERE status = 'approved'
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    res.json({
      investors: result.rows,
      pagination: paginationMeta(page, limit, parseInt(countResult.rows[0].count, 10)),
    });
  } catch (err) {
    next(err);
  }
});

// GET /investors/:id — public. Full profile: about, contact details,
// social channels, and the collaboration gallery — exactly the four
// pieces confirmed for the Investors page.
router.get('/:id', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT * FROM investors WHERE id = $1 AND status = 'approved'`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Investor not found.' });
    }
    const investor = result.rows[0];

    const [socials, gallery] = await Promise.all([
      pool.query(`SELECT platform, url FROM social_links WHERE owner_type = 'investor' AND owner_id = $1`, [investor.id]),
      pool.query(`SELECT id, image_url, caption FROM gallery_images WHERE owner_type = 'investor' AND owner_id = $1 AND status = 'approved'`, [investor.id]),
    ]);

    res.json({ investor, socials: socials.rows, gallery: gallery.rows });
  } catch (err) {
    next(err);
  }
});

// POST /investors — self-submission, enters as 'pending' for admin review.
// (Admins can also create one directly and mark it approved via the
// standard admin approve endpoint — no separate "admin create" route is
// needed since this one already accepts any authenticated user.)
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { name, about, contactEmail, contactPhone, contactWebsite } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'name is required.' });
    }

    const existing = await pool.query('SELECT id FROM investors WHERE user_id = $1', [req.user.id]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'This account already has an investor profile.' });
    }

    const result = await pool.query(
      `INSERT INTO investors (user_id, name, about, contact_email, contact_phone, contact_website)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [req.user.id, name.trim(), about || null, contactEmail || null, contactPhone || null, contactWebsite || null]
    );

    res.status(201).json({ investor: result.rows[0], message: 'Investor profile submitted — pending admin approval.' });
  } catch (err) {
    next(err);
  }
});

// PATCH /investors/:id — owner or admin edits.
router.patch('/:id', requireOwnerOrAdmin(getInvestorOwnerId), async (req, res, next) => {
  try {
    const bodyKeyMap = {
      about: 'about', contactEmail: 'contact_email', contactPhone: 'contact_phone',
      contactWebsite: 'contact_website', name: 'name',
    };
    const setClauses = [];
    const values = [];
    for (const [bodyKey, column] of Object.entries(bodyKeyMap)) {
      if (req.body[bodyKey] !== undefined) {
        values.push(req.body[bodyKey]);
        setClauses.push(`${column} = $${values.length}`);
      }
    }
    if (setClauses.length === 0) {
      return res.status(400).json({ error: 'No editable fields provided.' });
    }
    values.push(req.params.id);

    const result = await pool.query(
      `UPDATE investors SET ${setClauses.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Investor not found.' });
    }
    res.json({ investor: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// POST /investors/:id/social-links — owner or admin adds a social channel.
router.post('/:id/social-links', requireOwnerOrAdmin(getInvestorOwnerId), async (req, res, next) => {
  try {
    const { platform, url } = req.body;
    const validPlatforms = ['ig', 'fb', 'tt', 'li', 'wa', 'tw'];
    if (!validPlatforms.includes(platform) || !url) {
      return res.status(400).json({ error: `platform must be one of ${validPlatforms.join(', ')}, and url is required.` });
    }

    const result = await pool.query(
      `INSERT INTO social_links (owner_type, owner_id, platform, url)
       VALUES ('investor', $1, $2, $3)
       ON CONFLICT (owner_type, owner_id, platform) DO UPDATE SET url = EXCLUDED.url
       RETURNING *`,
      [req.params.id, platform, url]
    );
    res.status(201).json({ socialLink: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
