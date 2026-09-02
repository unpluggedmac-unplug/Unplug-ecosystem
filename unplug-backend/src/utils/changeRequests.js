// WHO OWNS A SUBMISSION, AND WHAT MAY BE ASKED OF THEM (spec §10.14).
//
// A change request hands a submission back to the member who sent it. Two
// questions have to be answerable before that can happen:
//
//   1. Which fields may an admin ask about? The approval queue already keeps a
//      per-type whitelist of editable columns, with labels. That list is reused
//      rather than copied, so the fields an admin can REQUEST are exactly the
//      fields an admin can EDIT, and the two cannot drift apart.
//
//   2. Whose submission is it? That is the awkward one, and the reason this
//      file exists.
//
// OWNERSHIP IS NOT UNIFORM.
//
// Some submissions carry the member's id directly. Others reach it through
// another table — a marketplace listing belongs to an advertiser, and the
// advertiser belongs to a member. Some carry no owner at all: a gallery image
// belongs to a bundle, and a share card is submitted by a stranger with no
// account.
//
// So ownership is declared per type, as SQL that returns one user id, with the
// table and column names as constants here. A type with no entry simply cannot
// be handed back — which is correct rather than a limitation: there is nobody
// to hand it to.

// type -> a query returning the owning user id for one submission.
//
// The parameter is always the submission id. Written out per type rather than
// derived, because each route through the schema is genuinely different and a
// clever generic version would be harder to check than five explicit ones.
const OWNER_SQL = {
  article: 'SELECT author_user_id AS user_id FROM articles WHERE id = $1',
  event: 'SELECT organizer_user_id AS user_id FROM events WHERE id = $1',
  directory_profile: 'SELECT user_id FROM profiles WHERE id = $1',
  investor: 'SELECT user_id FROM investors WHERE id = $1',
  marketplace: `SELECT a.user_id
                  FROM marketplace_listings l
                  JOIN advertisers a ON a.id = l.advertiser_id
                 WHERE l.id = $1`,
};

// Types the approval queue knows about but that cannot be handed back, and why.
// Listed rather than omitted so the gap is visible to the next person.
const NOT_RETURNABLE = {
  gallery: 'a gallery image belongs to a bundle, not directly to a member',
  share_card: 'a share card is submitted without an account',
  top10_entry: 'nothing editorial lives on the row; the profile is edited instead',
  competition_entry: 'an entry linked to a profile has no fields of its own',
};

function canRequestChanges(type) {
  return Object.prototype.hasOwnProperty.call(OWNER_SQL, type);
}

// The member who submitted this, or null when there is nobody to hand it to.
async function ownerOf(type, id, client) {
  const sql = OWNER_SQL[type];
  if (!sql) return null;
  const numericId = Number(id);
  if (!Number.isInteger(numericId)) return null;
  const r = await client.query(sql, [numericId]);
  return r.rows.length ? r.rows[0].user_id : null;
}

// Keep only the field names this type actually allows, in the order the admin
// sent them, without duplicates.
//
// `allowed` comes from the approval queue's own DETAILS whitelist, so a field
// that cannot be edited cannot be requested either. Anything else is dropped
// rather than rejected: an admin ticking a box that has since been removed
// should not have their whole request refused.
function cleanFields(requested, allowed) {
  if (!Array.isArray(requested)) return [];
  const ok = new Set(allowed);
  const out = [];
  for (const f of requested) {
    const name = String(f || '').trim();
    if (ok.has(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

// A request has to say something. Either name fields, or write a note — an
// empty one tells the member their submission needs changing and not what.
function isSayingSomething(fields, note) {
  return fields.length > 0 || String(note || '').trim().length > 0;
}

module.exports = {
  OWNER_SQL, NOT_RETURNABLE, canRequestChanges, ownerOf, cleanFields, isSayingSomething,
};
