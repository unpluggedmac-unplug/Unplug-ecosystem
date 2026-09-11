// Universal admin search — one secure, read-only endpoint for the Control Centre.
//
// This intentionally uses a fixed list of queries rather than accepting table or
// column names from the request. Search text is always passed as a parameter.
const express = require('express');
const pool = require('../db');
const { requireRole } = require('../middleware/auth');
const { getStaffAccess } = require('../utils/staffPermissions');

const router = express.Router();

function cleanRows(rows, type, section, resource) {
  return rows.map((row) => ({ ...row, type, section, ...(resource ? { resource } : {}) }));
}

router.get('/', requireRole('admin'), async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ query: q, groups: {}, total: 0 });
    if (q.length > 160) return res.status(400).json({ error: 'Search is too long.' });

    const like = `%${q}%`;
    const [articles, profiles, events, gallery, users, payments, inquiries, impactMakers, pages, banners] = await Promise.all([
      pool.query(
        `SELECT id, title AS label, COALESCE(subtitle, seo_title, '') AS detail, status, created_at
           FROM articles
          WHERE title ILIKE $1 OR COALESCE(subtitle,'') ILIKE $1 OR COALESCE(body,'') ILIKE $1
          ORDER BY created_at DESC LIMIT 12`, [like]),
      pool.query(
        `SELECT id, display_name AS label, COALESCE(contact_email, slug, '') AS detail, status, created_at
           FROM profiles
          WHERE display_name ILIKE $1 OR COALESCE(contact_email,'') ILIKE $1 OR COALESCE(slug,'') ILIKE $1
             OR COALESCE(bio,'') ILIKE $1
          ORDER BY created_at DESC LIMIT 12`, [like]),
      pool.query(
        `SELECT id, name AS label, COALESCE(venue, '') AS detail, status, created_at
           FROM events
          WHERE name ILIKE $1 OR COALESCE(venue,'') ILIKE $1 OR COALESCE(description,'') ILIKE $1
          ORDER BY created_at DESC LIMIT 12`, [like]),
      pool.query(
        `SELECT id, COALESCE(NULLIF(title,''), NULLIF(caption,''), 'Gallery image #' || id::text) AS label,
                COALESCE(supplied_by, image_url, '') AS detail, status, created_at
           FROM gallery_images
          WHERE COALESCE(title,'') ILIKE $1 OR COALESCE(caption,'') ILIKE $1 OR COALESCE(supplied_by,'') ILIKE $1
          ORDER BY created_at DESC LIMIT 12`, [like]),
      pool.query(
        `SELECT id, COALESCE(NULLIF(full_name,''), email) AS label, email AS detail, role AS status, created_at
           FROM users
          WHERE email ILIKE $1 OR COALESCE(full_name,'') ILIKE $1 OR COALESCE(phone,'') ILIKE $1
          ORDER BY created_at DESC LIMIT 12`, [like]),
      pool.query(
        `SELECT p.id, ('R' || trim(to_char(p.amount, 'FM999999990.00'))) AS label,
                (u.email || ' · ' || p.gateway_reference || ' · ' || p.linked_type) AS detail,
                p.status, p.created_at
           FROM payments p JOIN users u ON u.id = p.user_id
          WHERE u.email ILIKE $1 OR p.gateway_reference ILIKE $1 OR p.linked_type ILIKE $1
             OR p.id::text = $2
          ORDER BY p.created_at DESC LIMIT 12`, [like, q]),
      pool.query(
        `SELECT id, COALESCE(NULLIF(subject,''), name) AS label,
                (name || ' · ' || email) AS detail, status, created_at
           FROM inquiries
          WHERE name ILIKE $1 OR email ILIKE $1 OR COALESCE(subject,'') ILIKE $1 OR message ILIKE $1
          ORDER BY created_at DESC LIMIT 12`, [like]),
      pool.query(
        `SELECT id, display_name AS label, COALESCE(website_url, impact_maker_type, '') AS detail, status, created_at
           FROM impact_makers
          WHERE display_name ILIKE $1 OR COALESCE(first_name,'') ILIKE $1 OR COALESCE(surname,'') ILIKE $1
             OR COALESCE(bio,'') ILIKE $1 OR COALESCE(website_url,'') ILIKE $1
          ORDER BY created_at DESC LIMIT 12`, [like]),
      pool.query(
        `SELECT (page_key || ':' || content_key) AS id, content_key AS label,
                page_key AS detail, 'page content' AS status, updated_at AS created_at
           FROM page_content
          WHERE page_key ILIKE $1 OR content_key ILIKE $1 OR value ILIKE $1
          ORDER BY updated_at DESC LIMIT 12`, [like]),
      pool.query(
        `SELECT id,
                COALESCE(campaign_name, advertiser_name, name, slot_key) AS label,
                concat_ws(' · ', slot_key, NULLIF(advertiser_name,''), NULLIF(advertiser_email,'')) AS detail,
                CASE WHEN archived_at IS NOT NULL THEN 'archived'
                     ELSE COALESCE(moderation_status, CASE WHEN is_active THEN 'active' ELSE 'paused' END) END AS status,
                updated_at AS created_at
           FROM ad_slots
          WHERE slot_key ILIKE $1 OR COALESCE(link_url,'') ILIKE $1
             OR COALESCE(campaign_name,'') ILIKE $1 OR COALESCE(advertiser_name,'') ILIKE $1
             OR COALESCE(advertiser_contact,'') ILIKE $1 OR COALESCE(advertiser_email,'') ILIKE $1
          ORDER BY updated_at DESC LIMIT 12`, [like]),
    ]);

    const access = await getStaffAccess(req.user.id);
    const perms = new Set(access ? access.permissions : []);
    const can = (...needed) => access && (access.isSuperAdmin || needed.some((p) => perms.has(p)));
    const groups = {};
    if (can('content.view', 'content.manage')) groups.articles = cleanRows(articles.rows, 'Articles', 'manage', 'articles');
    if (can('directory.manage')) groups.profiles = cleanRows(profiles.rows, 'Directory Profiles', 'manage', 'profiles');
    if (can('events.manage')) groups.events = cleanRows(events.rows, 'Events', 'manage', 'events');
    if (can('media.manage')) groups.gallery = cleanRows(gallery.rows, 'Media & Gallery', 'manage', 'gallery');
    if (can('members.view', 'members.manage')) groups.users = cleanRows(users.rows, 'Members & Users', 'users');
    if (can('finance.view', 'finance.manage')) groups.payments = cleanRows(payments.rows, 'Payments', 'payqueue');
    if (can('crm.manage')) groups.inquiries = cleanRows(inquiries.rows, 'Enquiries', 'inquiries');
    if (can('content.view', 'content.manage')) groups.impactMakers = cleanRows(impactMakers.rows, 'Impact Makers', 'impactmakers');
    if (can('pages.manage')) groups.pages = cleanRows(pages.rows, 'Page Content', 'pagecms');
    if (can('advertising.manage')) groups.banners = cleanRows(banners.rows, 'Banner Campaigns', 'adbanners');
    const total = Object.values(groups).reduce((n, rows) => n + rows.length, 0);
    res.json({ query: q, groups, total });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
