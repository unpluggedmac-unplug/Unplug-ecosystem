const express = require('express');
const pool = require('../db');
const { logSubmission } = require('./activityLog');
const { requireAuth, requireRole } = require('../middleware/auth');
const { publishesFree } = require("../utils/publishingRights");
const { getPagination, paginationMeta } = require('../utils/pagination');
const { recordParticipationAsync } = require('../utils/participation');

const router = express.Router();

// GET /gallery — public, approved images only.
router.get('/', async (req, res, next) => {
  try {
    const { page, limit, offset } = getPagination(req);

    // The Gallery page is its own pool of content, separate from images that
    // live elsewhere on the site — a Directory business's listing photos
    // (owner_type='profile') and an investor's photos (owner_type='investor')
    // belong to THEIR pages, not the public Community Gallery. Only
    // owner_type='general' — a photo a member submitted specifically to the
    // Gallery, or one Admin added directly — ever shows here.
    //
    // visibility is the admin Gallery Management publish control (migration
    // 061), separate from the member-submission `status` moderation queue.
    // NULL visibility (every pre-existing / member-submitted row) still shows,
    // so this is fully backward compatible — only an explicit non-published
    // value (draft/unpublished/archived) hides an item.
    const visibleClause = `owner_type = 'general' AND status = 'approved' AND (visibility IS NULL OR visibility = 'published')`;
    const countResult = await pool.query(`SELECT COUNT(*) FROM gallery_images WHERE ${visibleClause}`);

    const result = await pool.query(
      `SELECT id, image_url, title, caption, alt_text, link_url, link_type,
              supplied_by, display_order, created_at
       FROM gallery_images
       WHERE ${visibleClause}
       ORDER BY COALESCE(display_order, 0) ASC, created_at DESC
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

// GET /gallery/admin/audit — admin. WHERE IS EVERY GALLERY PHOTO, AND WHY IS
// IT OR IS IT NOT VISIBLE.
//
// Read-only, and deliberately so: it changes nothing. It exists because a
// photo can be paid for, approved, and still appear nowhere, and until now
// there was no way to see that from the outside — the public endpoint only
// tells you what IS showing, never what should be and is not.
//
// Three things have to line up for a photo to appear in the Community
// Gallery: owner_type='general', status='approved', and visibility null or
// 'published'. This reports each one separately so the reason is obvious
// rather than inferred.
router.get('/admin/audit', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT g.id, g.owner_type, g.owner_id, g.status, g.visibility, g.bundle_id,
              g.caption, g.title, g.supplied_by, g.created_at, g.image_url,
              b.user_id AS bundle_user_id, b.status AS bundle_status,
              p.display_name AS listing_name, p.status AS listing_status,
              (g.owner_type = 'general'
               AND g.status = 'approved'
               AND (g.visibility IS NULL OR g.visibility = 'published')) AS shows_in_gallery
         FROM gallery_images g
         LEFT JOIN gallery_bundles b ON b.id = g.bundle_id
         LEFT JOIN profiles p ON g.owner_type = 'profile' AND p.id = g.owner_id
        ORDER BY g.created_at DESC`
    );

    const rows = result.rows.map((r) => {
      // Said in words, because "owner_type = profile" is not a reason anybody
      // outside this file should have to translate.
      let why = null;
      if (r.shows_in_gallery) {
        why = 'Showing in the Community Gallery.';
      } else if (r.status !== 'approved') {
        // Checked BEFORE the destination: a photo can be both unapproved and
        // filed somewhere odd, and "it has not been approved" is the reason
        // that is actually blocking it today. Where it will go afterwards is
        // still worth saying, so it is said in the same sentence.
        why = `Still ${r.status} — not approved yet.`
          + (r.owner_type !== 'general'
              ? ` When it is, it will go on the ${r.owner_type === 'profile' ? 'listing' : r.owner_type}, not the Community Gallery.`
              : '');
      } else if (r.owner_type !== 'general') {
        why = r.owner_type === 'profile'
          ? (r.listing_status === 'approved'
              ? `Filed as a photo on the listing "${r.listing_name}" — it shows there, not in the Community Gallery.`
              : `Filed as a photo on the listing "${r.listing_name || '(unknown)'}", and that listing is ${r.listing_status || 'missing'} — so it appears NOWHERE.`)
          : `Filed against ${r.owner_type}, so it never appears in the Community Gallery.`;
      } else {
        why = `Approved, but hidden by the admin visibility control (${r.visibility}).`;
      }
      return { ...r, why };
    });

    const stranded = rows.filter((r) => !r.shows_in_gallery && r.status === 'approved');
    res.json({
      total: rows.length,
      showing: rows.filter((r) => r.shows_in_gallery).length,
      approvedButNotShowing: stranded.length,
      images: rows,
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

    // Editorial staff and consultants never pay for a gallery bundle.
    let skipPayment = publishesFree(req.user);

    // THE FREE GALLERY CREDIT IS NOT CONDITIONAL ON WHERE THE PHOTOS GO.
    //
    // This whole block used to sit behind `finalOwnerType === 'profile'`. That
    // was invisible while the member dashboard always sent 'profile' — and the
    // moment it stopped (because a Community Gallery submission is not a
    // listing photo) it would have started CHARGING R100 to members who were
    // holding a free gallery credit. free_gallery_credits is a GALLERY credit:
    // it is spent on a gallery bundle wherever the photos end up.
    if (!skipPayment) {
      // One profile per member — profiles.user_id is unique.
      const profileResult = await pool.query(
        'SELECT id, type, package_tier, free_gallery_credits FROM profiles WHERE user_id = $1',
        [req.user.id]
      );
      const profile = profileResult.rows[0];
      if (profile) {
        // THE BUSINESS TIER ALLOWANCE IS AN ALLOWANCE OF LISTING PHOTOS — its
        // own error message says "allows N listing photo(s) total". It applies
        // only when the bundle is genuinely going onto the listing, which a
        // Community Gallery submission is not.
        if (finalOwnerType === 'profile' && Number(ownerId) === profile.id && profile.type === 'business') {
          const PHOTO_LIMITS = { basic: 1, pro: 3, premium: 5 };
          const limit = PHOTO_LIMITS[profile.package_tier] || 1;
          const existingCount = await pool.query(
            `SELECT COUNT(*) FROM gallery_images WHERE owner_type = 'profile' AND owner_id = $1 AND status != 'rejected'`,
            [profile.id]
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

    // One credit for the submission, not one per image — a ten-image bundle
    // is a single act of taking part.
    recordParticipationAsync(req.user.id, 'gallery_submit_or_interact', { contentType: 'gallery_image' });

    // Recorded when it is MADE, not only when an admin acts on it, so the
    // monthly account shows what came in as well as what was decided.
    logSubmission(req.user.id, 'gallery_submitted',
      `Gallery bundle of ${images.length} photo${images.length === 1 ? '' : 's'}`);

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
