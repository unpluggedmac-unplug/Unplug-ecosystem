const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const { getPagination, paginationMeta } = require('../utils/pagination');

const router = express.Router();

// GET /gallery — public, approved images only.
router.get('/', async (req, res, next) => {
  try {
    const { page, limit, offset } = getPagination(req);

    const countResult = await pool.query(`SELECT COUNT(*) FROM gallery_images WHERE status = 'approved'`);

    const result = await pool.query(
      `SELECT id, image_url, caption, supplied_by, created_at
       FROM gallery_images
       WHERE status = 'approved'
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    res.json({
      images: result.rows,
      pagination: paginationMeta(page, limit, parseInt(countResult.rows[0].count, 10)),
    });
  } catch (err) {
    next(err);
  }
});

// GET /gallery/mine — the authenticated member's own submissions, at any
// status.
router.get('/mine', requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, image_url, caption, status, created_at
       FROM gallery_images
       WHERE owner_type = 'profile' AND owner_id IN (SELECT id FROM profiles WHERE user_id = $1)
       ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json({ images: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /gallery — member submits a bundle of 1-3 images for R100 total
// (not per image). Creates a gallery_bundles row plus one gallery_images
// row per image, all starting as 'awaiting_payment' — call
// POST /payments/initiate with linkedType "gallery_bundle" and the
// bundle's id next. Images only enter the Admin Approval Queue once
// payment confirms (see applyPaymentEffect in payments.js).
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { images, ownerType, ownerId } = req.body; // images: [{ imageUrl, caption }, ...]
    if (!Array.isArray(images) || images.length === 0 || images.length > 3) {
      return res.status(400).json({ error: 'images must be an array of 1-3 items, each with an imageUrl.' });
    }
    if (images.some((img) => !img.imageUrl)) {
      return res.status(400).json({ error: 'Every image needs an imageUrl.' });
    }
    const finalOwnerType = ['profile', 'investor', 'general'].includes(ownerType) ? ownerType : 'general';

    // Tier-based free photo allowance — only applies when this bundle is
    // attached to the member's own Directory profile.
    let skipPayment = false;
    if (finalOwnerType === 'profile' && ownerId) {
      const profileResult = await pool.query(
        'SELECT id, type, package_tier, free_gallery_credits FROM profiles WHERE id = $1 AND user_id = $2',
        [ownerId, req.user.id]
      );
      if (profileResult.rows.length > 0) {
        const profile = profileResult.rows[0];
        if (profile.type === 'business') {
          const PHOTO_LIMITS = { basic: 1, pro: 3, premium: 5 };
          const limit = PHOTO_LIMITS[profile.package_tier] || 1;
          const existingCount = await pool.query(
            `SELECT COUNT(*) FROM gallery_images WHERE owner_type = 'profile' AND owner_id = $1 AND status != 'rejected'`,
            [ownerId]
          );
          const current = parseInt(existingCount.rows[0].count, 10);
          if (current + images.length > limit) {
            return res.status(400).json({ error: `Your ${profile.package_tier} Business package allows ${limit} listing photo(s) total — you already have ${current}.` });
          }
          skipPayment = true; // included free, within the tier's photo allowance
        } else if (profile.free_gallery_credits > 0) {
          skipPayment = true;
          await pool.query('UPDATE profiles SET free_gallery_credits = free_gallery_credits - 1 WHERE id = $1', [profile.id]);
        }
      }
    }

    const bundleResult = await pool.query(
      `INSERT INTO gallery_bundles (user_id, image_count, status) VALUES ($1, $2, $3) RETURNING *`,
      [req.user.id, images.length, skipPayment ? 'pending' : 'awaiting_payment']
    );
    const bundle = bundleResult.rows[0];

    const values = [];
    const valuePlaceholders = images.map((img, i) => {
      const base = i * 5;
      values.push(finalOwnerType, ownerId || null, img.imageUrl, img.caption || null, req.user.email);
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, ${bundle.id}, '${skipPayment ? 'pending' : 'awaiting_payment'}')`;
    });
    const insertResult = await pool.query(
      `INSERT INTO gallery_images (owner_type, owner_id, image_url, caption, supplied_by, bundle_id, status)
       VALUES ${valuePlaceholders.join(', ')}
       RETURNING *`,
      values
    );
    const insertedImages = insertResult.rows;

    res.status(201).json({
      bundle,
      images: insertedImages,
      message: skipPayment
        ? 'Bundle created using your package\'s included photo allowance — submitted for approval, no payment needed.'
        : `Bundle created — call POST /payments/initiate with linkedType "gallery_bundle" and this bundle's id (R${Number(bundle.price).toFixed(2)}) to submit for approval.`,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
