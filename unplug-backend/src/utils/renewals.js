// One-click renewal (spec §10.9).
//
//   "Expired services should display RENEW. The user should be able to renew
//    with one click. The renewal process should prepopulate: Existing service,
//    Existing information, Existing media where applicable. User only needs to:
//    Confirm/update, Review, Pay, Submit"
//
// So a renewal is a NEW submission that starts as a copy of the old one. It is
// deliberately not an edit of the old row:
//
//   - the expired service is a record of what ran, and when. Overwriting it
//     would lose that, and §10.11 says the underlying record must stay for
//     history, reporting, renewal and audit;
//   - the new one has to go through payment and review like any other
//     submission, and reusing the old row would mean a live service briefly
//     dropping back to awaiting_payment.
//
// The copy starts at `awaiting_payment` for exactly the same reason every other
// paid submission does: nothing is reviewed until the money has arrived.
//
// WHAT IS DELIBERATELY NOT COPIED: dates, status, and anything the admin set.
// A renewed listing gets a fresh term, not the old one; a renewed highlight
// does not inherit an admin's priority or their chosen image.

const pool = require('../db');

// Each renewable service: how to find it for its owner, and which columns
// carry forward. Written out per type rather than derived, for the same reason
// the rest of this codebase does it — each route through the schema is
// genuinely different, and a generic copier would be harder to check.
//
// `owner` is a WHERE fragment taking the member's id as $2. Ownership is
// re-checked here rather than trusted from the caller.
const RENEWABLE = {
  listing: {
    table: 'marketplace_listings',
    label: 'Marketplace listing',
    // Through advertisers, the same route mySubmissions uses.
    owner: `advertiser_id IN (SELECT id FROM advertisers WHERE user_id = $2)`,
    // Everything a member typed or uploaded. Not active_from/active_to: those
    // are the OLD term.
    copy: ['advertiser_id', 'poster_image_url', 'headline', 'duration_days'],
  },

  highlight: {
    table: 'highlights',
    label: 'Highlight',
    // A highlight has no owner column — the owner is whoever owns the article
    // or profile it points at. Both routes, or half a member's highlights
    // silently cannot be renewed.
    owner: `(
      (target_type = 'article'
         AND target_id IN (SELECT id FROM articles WHERE author_user_id = $2))
      OR (target_type = 'directory'
         AND target_id IN (SELECT id FROM profiles WHERE user_id = $2))
    )`,
    // NOT priority, admin_image_url or is_admin: those are the admin's, and a
    // member must not renew their way into a placement they were given once.
    copy: ['target_type', 'target_id', 'duration_days'],
  },

  advertising: {
    table: 'ad_slots',
    label: 'Advert',
    owner: `owner_user_id = $2`,
    // ad_slots keeps its own vocabulary: the status column is
    // `moderation_status`, and a member's new advert starts life as
    // 'pending_payment' rather than 'awaiting_payment'. Renewing has to speak
    // the table's language, not the shared one, or the row is created in a
    // status the rest of the advert flow does not recognise.
    statusColumn: 'moderation_status',
    initialStatus: 'pending_payment',
    // slot_key is indexed but not unique, so it copies safely. NOT starts_at /
    // ends_at (the old term), payment_id (the old payment), is_active or
    // display_order (an admin's placement decisions).
    copy: ['slot_key', 'image_url', 'mobile_image_url', 'link_url', 'name',
      'cta_text', 'owner_user_id', 'duration_days'],
  },

  event: {
    table: 'events',
    label: 'Event',
    owner: `organizer_user_id = $2`,
    // Everything except the dates. An event that has happened is re-listed
    // with the same details and a new date, which is what "prepopulate, then
    // confirm/update" means for something that occurs on a day.
    copy: ['organizer_user_id', 'name', 'venue', 'description', 'image_url',
      'entrance_fee', 'contact_details', 'event_link', 'start_time', 'end_time'],
  },
};

// events.event_date is NOT NULL, so a copy needs a placeholder the member then
// changes. Today is used rather than the old date: an event dated in the past
// would be created already expired, which is a worse starting point than one
// the member must obviously edit.
const REQUIRED_DEFAULTS = {
  events: { event_date: 'CURRENT_DATE' },
  // A renewed advert must not be on the site before it is paid for, and must
  // not inherit a position an admin gave the last one.
  ad_slots: { is_active: 'false', display_order: '0' },
};

function isRenewable(type) {
  return Object.prototype.hasOwnProperty.call(RENEWABLE, type);
}

// Why a type is not renewable, so the caller can say something true rather
// than "unknown type". Listed rather than omitted so the gap is visible.
const NOT_RENEWABLE = {
  article: 'an article stays published — there is no term to renew',
  gallery: 'gallery photos stay published; there is nothing that expires',
  competition: 'a competition entry ends when the competition closes',
  profile: 'a directory listing renews through its package, which carries a tier and a price — a separate flow',
};

// The old service, if it is this member's and it exists.
async function loadOwned(type, id, userId, client = pool) {
  const spec = RENEWABLE[type];
  if (!spec) return null;
  const numericId = Number(id);
  if (!Number.isInteger(numericId)) return null;

  const r = await client.query(
    `SELECT * FROM ${spec.table} WHERE id = $1 AND ${spec.owner}`,
    [numericId, Number(userId)]
  );
  return r.rows.length ? r.rows[0] : null;
}

// Renew: create a fresh submission copied from the old one.
//
// Returns { renewal, from } or an { error } a caller can show. The new row is
// `awaiting_payment` and carries no dates — the member confirms or updates,
// then pays, exactly as §10.9 describes.
async function renew(type, id, userId, client = pool) {
  if (!isRenewable(type)) {
    return {
      error: NOT_RENEWABLE[type]
        ? `This cannot be renewed: ${NOT_RENEWABLE[type]}.`
        : 'That service cannot be renewed.',
    };
  }

  const spec = RENEWABLE[type];
  const previous = await loadOwned(type, id, userId, client);
  if (!previous) {
    // Not found and not yours are the same answer on purpose: whether a
    // listing id exists is not something to confirm to someone who does not
    // own it.
    return { error: 'That service could not be found.' };
  }

  const columns = [...spec.copy];
  const values = columns.map((c) => previous[c]);

  const defaults = REQUIRED_DEFAULTS[spec.table] || {};
  const extraColumns = Object.keys(defaults);
  const extraSql = extraColumns.map((c) => defaults[c]);

  const placeholders = columns.map((_, i) => `$${i + 1}`).concat(extraSql);

  // Each table names its own status column and its own "not paid yet" value.
  // Assuming `status = 'awaiting_payment'` everywhere would create an advert in
  // a state the advert flow does not recognise.
  const statusColumn = spec.statusColumn || 'status';
  const initialStatus = spec.initialStatus || 'awaiting_payment';

  const r = await client.query(
    `INSERT INTO ${spec.table} (${columns.concat(extraColumns).join(', ')}, ${statusColumn})
     VALUES (${placeholders.join(', ')}, $${columns.length + 1})
     RETURNING *`,
    values.concat([initialStatus])
  );

  return { renewal: r.rows[0], from: previous, label: spec.label };
}

module.exports = { RENEWABLE, NOT_RENEWABLE, isRenewable, loadOwned, renew };
