// Turning a form submission into a contact, and sometimes a deal.
//
// EMAIL IS THE IDENTITY. Somebody enquires about advertising in March, buys a
// directory listing in June and asks a question in September. Without a key
// that is three strangers; with email as the key it is one relationship, and
// the person answering in September can see the other two.
//
// CAPTURE NEVER FAILS THE SUBMISSION. Every function here swallows its own
// errors. A contact form that returns 500 because the CRM had a problem has
// lost a real enquiry in order to file it — which is the opposite of the point.
//
// SOURCE IS RECORDED ONCE AND NEVER OVERWRITTEN. The channel that first
// brought somebody in is the one worth knowing. Updating it on every later
// visit would eventually attribute everybody to "direct", because that is how
// people return once they know the address.

const pool = require('../db');

// Which enquiry becomes which kind of deal, and what it is provisionally
// worth. The values are starting points a person then corrects — a forecast
// built on zeros is not a forecast, and one built on invented certainty is
// worse.
const DEAL_SHAPES = {
  advertising: { source: 'advertising', title: 'Advertising enquiry', value: 0, probability: 20 },
  directory: { source: 'directory_package', title: 'Directory listing enquiry', value: 0, probability: 25 },
  marketplace: { source: 'marketplace', title: 'Marketplace enquiry', value: 0, probability: 20 },
  general: null,   // a general question is not a sale, and pretending it is
                   // fills the pipeline with noise nobody can close
};

function cleanEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return email.includes('@') && email.length <= 255 ? email : null;
}

// Finds or creates the contact for an email address.
//
// The insert is a single statement so two forms submitted at once cannot both
// decide the contact does not exist and both create one.
async function upsertContact({ email, fullName, phone, attribution, userId }) {
  const address = cleanEmail(email);
  if (!address) return null;

  const attr = attribution || {};
  const known = Boolean(attr.source);

  const result = await pool.query(
    `INSERT INTO crm_contacts
       (email, full_name, phone, user_id, source, utm_source, utm_medium,
        utm_campaign, referrer_host, source_known)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (LOWER(email)) DO UPDATE SET
       -- Filled in only where it was previously blank. Somebody who gave
       -- their full name in March and just an email in June should not lose
       -- the name.
       full_name = COALESCE(crm_contacts.full_name, EXCLUDED.full_name),
       phone     = COALESCE(crm_contacts.phone, EXCLUDED.phone),
       user_id   = COALESCE(crm_contacts.user_id, EXCLUDED.user_id),
       -- Attribution is NEVER overwritten once known. See the note at the top.
       source        = CASE WHEN crm_contacts.source_known THEN crm_contacts.source ELSE EXCLUDED.source END,
       utm_source    = CASE WHEN crm_contacts.source_known THEN crm_contacts.utm_source ELSE EXCLUDED.utm_source END,
       utm_medium    = CASE WHEN crm_contacts.source_known THEN crm_contacts.utm_medium ELSE EXCLUDED.utm_medium END,
       utm_campaign  = CASE WHEN crm_contacts.source_known THEN crm_contacts.utm_campaign ELSE EXCLUDED.utm_campaign END,
       referrer_host = CASE WHEN crm_contacts.source_known THEN crm_contacts.referrer_host ELSE EXCLUDED.referrer_host END,
       source_known  = crm_contacts.source_known OR EXCLUDED.source_known,
       last_seen_at  = now(),
       updated_at    = now()
     RETURNING *`,
    [address, fullName || null, phone || null, userId || null,
     attr.source || null, attr.utmSource || null, attr.utmMedium || null,
     attr.utmCampaign || null, attr.referrerHost || null, known]);

  return result.rows[0];
}

// Puts something on the contact's timeline.
async function addActivity({ contactId, dealId, kind, subject, body, createdBy, occurredAt }) {
  if (!contactId) return null;
  const r = await pool.query(
    `INSERT INTO crm_activities (contact_id, deal_id, kind, subject, body, created_by, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, now())) RETURNING *`,
    [contactId, dealId || null, kind, subject || null, body || null, createdBy || null, occurredAt || null]);
  return r.rows[0];
}

// Opens a deal, unless one of the same kind is already open for this contact.
//
// WITHOUT THAT CHECK the pipeline fills with duplicates: somebody who enquires
// three times about advertising is one opportunity, not three, and a kanban
// showing three is a kanban nobody trusts.
async function openDeal({ contactId, shape, title, value }) {
  const spec = DEAL_SHAPES[shape];
  if (!spec || !contactId) return null;

  const existing = await pool.query(
    `SELECT * FROM crm_deals
      WHERE contact_id = $1 AND source = $2 AND stage NOT IN ('won', 'lost')
      ORDER BY created_at DESC LIMIT 1`, [contactId, spec.source]);
  if (existing.rowCount > 0) {
    // Touched, so it rises up a pipeline sorted by recent activity — a second
    // enquiry is a signal even when it is not a second opportunity.
    await pool.query('UPDATE crm_deals SET updated_at = now() WHERE id = $1', [existing.rows[0].id]);
    return existing.rows[0];
  }

  const r = await pool.query(
    `INSERT INTO crm_deals (contact_id, title, stage, value, probability, source)
     VALUES ($1, $2, 'prospect', $3, $4, $5) RETURNING *`,
    [contactId, title || spec.title, value || spec.value, spec.probability, spec.source]);
  return r.rows[0];
}

// The one call a form route makes.
//
// Returns { contact, deal } or nulls. NEVER THROWS.
async function captureSubmission({
  email, fullName, phone, formName, message, shape, attribution, userId,
}) {
  try {
    const contact = await upsertContact({ email, fullName, phone, attribution, userId });
    if (!contact) return { contact: null, deal: null };

    const deal = shape ? await openDeal({ contactId: contact.id, shape }) : null;

    await addActivity({
      contactId: contact.id,
      dealId: deal ? deal.id : null,
      kind: 'form',
      subject: formName || 'Form submission',
      // The message itself, so somebody reading the timeline sees what was
      // actually said rather than "submitted a form".
      body: message ? String(message).slice(0, 4000) : null,
    });

    return { contact, deal };
  } catch (err) {
    console.error('[crm] capture failed:', err.message);
    return { contact: null, deal: null };
  }
}

// What is known about where this visit came from.
//
// Read from analytics_sessions, which the site already maintains. That table
// is only written after somebody accepts the consent bar, so for a visitor who
// declined this returns nothing at all — and nothing is the honest answer.
// Recording them as "Direct" would quietly inflate direct traffic with people
// who actually arrived from Instagram.
async function attributionFor(sessionId) {
  if (!sessionId) return {};
  try {
    // The columns are source / medium / campaign — NOT utm_source and friends.
    // An earlier version of this query asked for names that do not exist; it
    // threw, the catch below swallowed it, and attribution would have been
    // silently empty for ever while looking like it was working.
    const r = await pool.query(
      `SELECT source, medium, campaign, referrer_host
         FROM analytics_sessions WHERE session_id = $1`, [sessionId]);
    if (r.rowCount === 0) return {};
    const row = r.rows[0];
    return {
      source: row.source || null,
      referrerHost: row.referrer_host || null,
      utmSource: row.source || null,
      utmMedium: row.medium || null,
      utmCampaign: row.campaign || null,
    };
  } catch (err) {
    // Attribution is a nice-to-have and must never be the reason a capture
    // fails — but it IS logged, so a query that stops working is noticed
    // rather than quietly returning nothing for months.
    console.error('[crm] could not read attribution:', err.message);
    return {};
  }
}

module.exports = {
  captureSubmission, upsertContact, openDeal, addActivity, attributionFor,
  cleanEmail, DEAL_SHAPES,
};
