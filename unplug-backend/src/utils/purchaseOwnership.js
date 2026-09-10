// Central ownership check for paid self-service resources.
// A payment must never be created for a resource owned by another member.
// Keep this mapping in one place so single-service and cart checkout cannot drift.

const pool = require('../db');

async function ownerFor(linkedType, linkedId) {
  const id = Number(linkedId);
  if (!Number.isInteger(id)) return null;

  const queries = {
    profile_package: `SELECT user_id AS owner_id FROM profiles WHERE id = $1`,
    profile_upgrade: `SELECT p.user_id AS owner_id FROM profile_upgrades u JOIN profiles p ON p.id = u.profile_id WHERE u.id = $1`,
    competition_entry: `SELECT p.user_id AS owner_id FROM competition_entries e JOIN profiles p ON p.id = e.profile_id WHERE e.id = $1`,
    marketplace_listing: `SELECT a.user_id AS owner_id FROM marketplace_listings l JOIN advertisers a ON a.id = l.advertiser_id WHERE l.id = $1`,
    article_publish: `SELECT author_user_id AS owner_id FROM articles WHERE id = $1`,
    event_listing: `SELECT organizer_user_id AS owner_id FROM events WHERE id = $1`,
    gallery_bundle: `SELECT user_id AS owner_id FROM gallery_bundles WHERE id = $1`,
    top10_entry: `SELECT p.user_id AS owner_id FROM top10_entries t JOIN profiles p ON p.id = t.profile_id WHERE t.id = $1`,
    ad_banner: `SELECT owner_user_id AS owner_id FROM ad_slots WHERE id = $1`,
  };

  if (linkedType === 'highlight') {
    const h = await pool.query('SELECT target_type, target_id FROM highlights WHERE id = $1', [id]);
    if (!h.rowCount) return null;
    const row = h.rows[0];
    if (row.target_type === 'article') {
      const r = await pool.query('SELECT author_user_id AS owner_id FROM articles WHERE id = $1', [row.target_id]);
      return r.rowCount ? r.rows[0].owner_id : null;
    }
    if (row.target_type === 'directory') {
      const r = await pool.query('SELECT user_id AS owner_id FROM profiles WHERE id = $1', [row.target_id]);
      return r.rowCount ? r.rows[0].owner_id : null;
    }
    return null;
  }

  // vote_bundle is intentionally not owner-scoped: it represents votes a buyer
  // purchases for an entry, not a service record the buyer owns.
  // edition_download is similarly a public product purchase.
  if (linkedType === 'vote_bundle' || linkedType === 'edition_download') return undefined;

  const sql = queries[linkedType];
  if (!sql) return undefined;
  const result = await pool.query(sql, [id]);
  return result.rowCount ? result.rows[0].owner_id : null;
}

async function assertPurchasableByUser(linkedType, linkedId, userId) {
  const ownerId = await ownerFor(linkedType, linkedId);
  // undefined means the service is intentionally not ownership-scoped.
  if (ownerId === undefined) return true;
  if (ownerId === null) {
    const err = new Error('The service you are trying to pay for could not be found.');
    err.code = 'PURCHASE_NOT_FOUND';
    throw err;
  }
  if (Number(ownerId) !== Number(userId)) {
    const err = new Error('You can only pay for services submitted from your own account.');
    err.code = 'PURCHASE_NOT_OWNED';
    throw err;
  }
  return true;
}

module.exports = { ownerFor, assertPurchasableByUser };
