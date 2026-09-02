// ONE SHAPE FOR "SOMETHING I SUBMITTED", whatever it was.
//
// §4 gives the member a menu of My Articles, My Events, My Listings, My
// Advertising, My Competitions — and My Submissions above them. Those are not
// six features. They are one list with a filter on it, and building them as six
// features is how six pages end up disagreeing about what "pending" looks like.
//
// So this file answers one question — "what has this member submitted?" — and
// returns every answer in the same shape:
//
//   { type, typeLabel, id, title, status, statusLabel, submittedAt,
//     expiresAt, amount, paymentStatus, reference }
//
// Each "My X" section is then this list with `type` set, and My Submissions is
// this list with nothing set. One renderer, one status vocabulary, six entry
// points.
//
// WHY THE SQL IS WRITTEN OUT PER TYPE rather than generated from a table name:
// each route through the schema is genuinely different. An article is owned by
// author_user_id; an event by organizer_user_id; a listing through advertisers;
// a competition entry and a gallery image through the member's profile. A
// generic builder covering all five would be harder to check than five explicit
// queries, and this is the same reasoning the OWNER_SQL map in changeRequests.js
// already settled on. Following it rather than inventing a second convention.

const pool = require('../db');
const { STATUSES } = require('./submissionStatus');

// What the member is told each status means.
//
// THE SINGLE PLACE. The highlights dashboard grew its own label chain and
// ended a `credit_issued` submission with "Active", because the chain fell
// through to a default. Every label a member reads for a submission status
// comes from here, and anything not listed is surfaced as itself rather than
// guessed at — an honest unknown beats a confident wrong one.
const STATUS_LABEL = {
  draft: 'Draft',
  awaiting_payment: 'Awaiting payment',
  pending: 'Awaiting approval',
  changes_requested: 'Changes needed',
  resubmitted: 'Changes submitted',
  approved: 'Approved',
  // NOTE: `rejected` currently does double duty as "we refused this" and "you
  // cancelled it" — logged as an open item in docs/progress-log.md. Worded for
  // the commoner case; it should be split before this wording is trusted.
  rejected: 'Not approved',
  credit_issued: 'Credit issued',
  expired: 'Expired',
};

function statusLabel(status) {
  if (Object.prototype.hasOwnProperty.call(STATUS_LABEL, status)) return STATUS_LABEL[status];
  return String(status || 'Unknown');
}

// Every status this file knows how to label must be a real one, or a member
// reads a label for something that can never happen. Checked at load, so a
// typo here is a startup failure rather than a wrong word on a dashboard.
for (const status of Object.keys(STATUS_LABEL)) {
  if (!Object.prototype.hasOwnProperty.call(STATUSES, status)) {
    throw new Error(`mySubmissions: '${status}' is not a status in submissionStatus.js`);
  }
}

// The reference and money for one submission, joined the same way everywhere.
//
// payments.linked_id has no foreign key, so it is matched on type + id — the
// same join highlights.js and submissionReference.js already use. The order's
// reference wins when there is one, because that is the UNP-… the member was
// shown and put on their EFT; a payment made on its own has only its gateway
// reference. Newest payment only: a resubmission can be paid for twice.
const PAYMENT_JOIN = (linkedType) => `
  LEFT JOIN LATERAL (
    SELECT COALESCE(o.reference, p.gateway_reference) AS reference,
           p.status AS payment_status,
           p.amount AS amount
      FROM payments p
      LEFT JOIN orders o ON o.id = p.order_id
     WHERE p.linked_type = '${linkedType}' AND p.linked_id = sub.id
     ORDER BY p.created_at DESC, p.id DESC
     LIMIT 1
  ) pay ON TRUE`;

// One descriptor per menu item in §4.
//
// `sql` returns the common shape for one member. The parameter is always the
// user id, and it is always the ONLY parameter — no descriptor interpolates
// anything from a request.
const TYPES = {
  article: {
    label: 'Article',
    plural: 'Articles',
    sql: `
      SELECT 'article' AS type, sub.id, sub.title, sub.status,
             sub.created_at AS submitted_at, NULL::date AS expires_at,
             pay.amount, pay.payment_status, pay.reference
        FROM articles sub
        ${PAYMENT_JOIN('article_publish')}
       WHERE sub.author_user_id = $1`,
  },

  event: {
    label: 'Event',
    plural: 'Events',
    sql: `
      SELECT 'event' AS type, sub.id, sub.name AS title, sub.status,
             sub.created_at AS submitted_at,
             COALESCE(sub.end_date, sub.event_date) AS expires_at,
             pay.amount, pay.payment_status, pay.reference
        FROM events sub
        ${PAYMENT_JOIN('event_listing')}
       WHERE sub.organizer_user_id = $1`,
  },

  listing: {
    label: 'Marketplace listing',
    plural: 'Listings',
    // A listing's text is `headline`, and it is nullable — an unnamed listing
    // is shown as what it is rather than as a blank row.
    sql: `
      SELECT 'listing' AS type, sub.id,
             COALESCE(NULLIF(sub.headline, ''), 'Marketplace listing') AS title,
             sub.status,
             sub.created_at AS submitted_at, sub.active_to AS expires_at,
             pay.amount, pay.payment_status, pay.reference
        FROM marketplace_listings sub
        JOIN advertisers adv ON adv.id = sub.advertiser_id
        ${PAYMENT_JOIN('marketplace_listing')}
       WHERE adv.user_id = $1`,
  },

  advertising: {
    label: 'Advert',
    plural: 'Advertising',
    // ad_slots predates the shared vocabulary and carries moderation_status
    // rather than status. Aliased here so the member sees the same words as
    // everywhere else; the column itself is not touched.
    sql: `
      SELECT 'advertising' AS type, sub.id, sub.name AS title,
             sub.moderation_status AS status,
             sub.created_at AS submitted_at, sub.ends_at AS expires_at,
             pay.amount, pay.payment_status, pay.reference
        FROM ad_slots sub
        ${PAYMENT_JOIN('ad_banner')}
       WHERE sub.owner_user_id = $1`,
  },

  competition: {
    label: 'Competition entry',
    plural: 'Competitions',
    sql: `
      SELECT 'competition' AS type, sub.id, c.name AS title, sub.status,
             sub.created_at AS submitted_at, NULL::date AS expires_at,
             pay.amount, pay.payment_status, pay.reference
        FROM competition_entries sub
        JOIN competitions c ON c.id = sub.competition_id
        ${PAYMENT_JOIN('competition_entry')}
       WHERE sub.profile_id IN (SELECT id FROM profiles WHERE user_id = $1)`,
  },

  gallery: {
    label: 'Gallery submission',
    plural: 'Gallery',
    // A bundle is the submission — it is what was paid for and what an admin
    // reviews. The photos inside it move with it, which is why the spine keeps
    // gallery_bundles and gallery_images together.
    //
    // The bundle is owned by the USER directly (gallery_bundles.user_id). It is
    // gallery_images that hangs off a profile via owner_type/owner_id; reading
    // the bundle that way finds nothing.
    sql: `
      SELECT 'gallery' AS type, sub.id,
             CASE WHEN sub.image_count = 1 THEN '1 photo'
                  ELSE sub.image_count || ' photos' END AS title,
             sub.status,
             sub.created_at AS submitted_at, NULL::date AS expires_at,
             pay.amount, pay.payment_status, pay.reference
        FROM gallery_bundles sub
        ${PAYMENT_JOIN('gallery_bundle')}
       WHERE sub.user_id = $1`,
  },

  // ---- Term-based services. Added for My Services (§5), which needs things
  // that can be active, expiring or expired. ----

  highlight: {
    label: 'Highlight',
    plural: 'Highlights',
    // A highlight has no owner column: it points at an article or a directory
    // profile, and the owner is whoever owns THAT. Both routes are needed —
    // checking only one silently hides half a member's highlights.
    sql: `
      SELECT 'highlight' AS type, sub.id,
             COALESCE(
               CASE WHEN sub.target_type = 'article' THEN a.title ELSE p.display_name END,
               'Highlight') AS title,
             sub.status,
             sub.created_at AS submitted_at, sub.end_date AS expires_at,
             pay.amount, pay.payment_status, pay.reference
        FROM highlights sub
        LEFT JOIN articles a ON sub.target_type = 'article'   AND a.id = sub.target_id
        LEFT JOIN profiles p ON sub.target_type = 'directory' AND p.id = sub.target_id
        ${PAYMENT_JOIN('highlight')}
       WHERE (sub.target_type = 'article'   AND a.author_user_id = $1)
          OR (sub.target_type = 'directory' AND p.user_id = $1)`,
  },

  profile: {
    label: 'Directory listing',
    plural: 'Directory listing',
    // The paid directory package. renews_at is the end of the term, which is
    // why the spine counts profiles as expiring even though the row itself
    // never goes away.
    sql: `
      SELECT 'profile' AS type, sub.id, sub.display_name AS title, sub.status,
             sub.created_at AS submitted_at, sub.renews_at::date AS expires_at,
             pay.amount, pay.payment_status, pay.reference
        FROM profiles sub
        ${PAYMENT_JOIN('profile_package')}
       WHERE sub.user_id = $1`,
  },
};

const TYPE_KEYS = Object.keys(TYPES);

// WHICH TYPES EACH MENU ITEM SHOWS.
//
// The two §4 menu items mean different things and must keep meaning different
// things, so each names its own set rather than both defaulting to "all".
//
// My Submissions is what you SENT IN — its lifecycle is review. My Services is
// what you are PAYING FOR — its lifecycle is a term, so it adds the two
// term-based services and drops competitions, which are neither bought for a
// period nor renewable: an entry ends when the competition closes, and that is
// the competition's business, not the member's.
const SUBMISSION_TYPES = ['article', 'event', 'listing', 'advertising', 'competition', 'gallery'];
const SERVICE_TYPES = ['article', 'event', 'listing', 'advertising', 'gallery', 'highlight', 'profile'];

function isType(type) {
  return Object.prototype.hasOwnProperty.call(TYPES, type);
}

// What this member has, newest first.
//
// `only` is the set the calling menu item covers (SUBMISSION_TYPES or
// SERVICE_TYPES) and is REQUIRED to be passed explicitly by callers that care —
// it defaults to submissions so existing callers keep their behaviour. Adding a
// type to TYPES must never silently change what an existing section shows.
//
// `type` narrows further to one menu item. An unrecognised type returns nothing
// rather than everything: a filter that silently stops filtering is how a member
// ends up looking at the wrong list.
async function listFor(userId, options = {}, client = pool) {
  const id = Number(userId);
  if (!Number.isInteger(id)) return [];

  const set = Array.isArray(options.only) ? options.only : SUBMISSION_TYPES;
  if (options.type && !isType(options.type)) return [];
  if (options.type && set.indexOf(options.type) === -1) return [];

  const wanted = options.type ? [options.type] : set;

  const parts = wanted.map((key) => TYPES[key].sql);
  const rows = await client.query(
    `${parts.join('\n      UNION ALL\n')}
     ORDER BY submitted_at DESC, id DESC`,
    [id]
  );

  return rows.rows.map((r) => ({
    type: r.type,
    typeLabel: TYPES[r.type].label,
    id: r.id,
    title: r.title,
    status: r.status,
    statusLabel: statusLabel(r.status),
    submittedAt: r.submitted_at,
    expiresAt: r.expires_at,
    amount: r.amount === null || r.amount === undefined ? null : Number(r.amount),
    paymentStatus: r.payment_status || null,
    reference: r.reference || null,
  }));
}

// ---------------------------------------------------------------------------
// MY SERVICES (§5): active · pending · expiring · expired · requiring changes
//                   · awaiting payment
//
// §5 names those six buckets and stops there, so this decides only which bucket
// a service is in — it invents no fields.

// HOW LONG BEFORE THE END A SERVICE COUNTS AS "EXPIRING".
//
// The spec asks for an Expiring bucket without saying how wide it is, so this
// is a judgement, not a requirement: 30 days matches the marketplace listing
// duration (30 days exactly) and leaves room for an EFT to clear before the
// service drops, which matters on a site that is paid by EFT. One constant, so
// changing it is changing one number.
const EXPIRING_WITHIN_DAYS = 30;

// Buckets in the order a member should read them: what needs them first, then
// what is running, then what is over.
const SERVICE_BUCKETS = [
  'awaiting_payment', 'requiring_changes', 'pending', 'expiring', 'active', 'expired',
];

const BUCKET_LABEL = {
  awaiting_payment: 'Awaiting payment',
  requiring_changes: 'Requiring changes',
  pending: 'Pending',
  expiring: 'Expiring soon',
  active: 'Active',
  expired: 'Expired',
};

// Whole days from today until a date, or null when there is no term.
//
// Compared as calendar days, not milliseconds: a service ending today has not
// expired, and treating "now" as a moment would expire it part-way through its
// last day — the same mistake multi-day events made.
function daysUntil(value, today) {
  if (!value) return null;
  const end = String(value).slice(0, 10);
  const start = String(today).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(end) || !/^\d{4}-\d{2}-\d{2}$/.test(start)) return null;
  return Math.round((Date.parse(end + 'T00:00:00Z') - Date.parse(start + 'T00:00:00Z')) / 86400000);
}

// Which of §5's six buckets this service is in.
//
// Status decides first, because a service awaiting payment is not "active" no
// matter what its dates say. Only an approved service is measured against its
// term, and one with no term is simply active — an article stays published.
//
// `today` is passed in rather than read from the clock so the caller can use the
// DATABASE's today. Working it out from Node's is a second clock, and the two
// disagree whenever the server's local date is ahead of UTC — the bug the
// highlights dashboard already had.
function bucketFor(service, today) {
  const status = service.status;

  if (status === 'awaiting_payment') return 'awaiting_payment';
  if (status === 'changes_requested') return 'requiring_changes';
  if (status === 'pending' || status === 'resubmitted') return 'pending';
  if (status === 'expired') return 'expired';

  // Anything that ended badly is over, whatever its dates say.
  if (status === 'rejected' || status === 'credit_issued' || status === 'draft') return 'expired';

  if (status === 'approved') {
    const left = daysUntil(service.expiresAt, today);
    if (left === null) return 'active';          // no term — an article stays published
    if (left < 0) return 'expired';
    if (left <= EXPIRING_WITHIN_DAYS) return 'expiring';
    return 'active';
  }

  // An unknown status is shown rather than dropped. Losing a member's paid
  // service because a status was added is worse than an odd-looking bucket.
  return 'active';
}

// The member's services, already bucketed. Empty buckets are returned too, so
// the dashboard can say "nothing expiring" rather than leaving a silent gap.
function groupServices(services, today) {
  const groups = SERVICE_BUCKETS.map((key) => ({ key, label: BUCKET_LABEL[key], services: [] }));
  const byKey = Object.fromEntries(groups.map((g) => [g.key, g]));
  for (const service of services) {
    byKey[bucketFor(service, today)].services.push(service);
  }
  return groups;
}

module.exports = {
  TYPES, TYPE_KEYS, SUBMISSION_TYPES, SERVICE_TYPES,
  STATUS_LABEL, statusLabel, isType, listFor,
  EXPIRING_WITHIN_DAYS, SERVICE_BUCKETS, BUCKET_LABEL,
  daysUntil, bucketFor, groupServices,
};
