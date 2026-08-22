// Telling the admin that something happened.
//
// One function, called from everywhere. Two rules make it safe to sprinkle
// through request paths:
//
//   IT NEVER THROWS. A notification is a courtesy; failing to record one must
//   not fail the signup, comment or payment that caused it. Errors are logged
//   and swallowed.
//
//   IT NEVER BLOCKS. Callers use notifyAdminAsync and carry on. Nothing a
//   reader is waiting for should wait on a bookkeeping insert.
//
// ROLLING UP. Pass a dedupeKey and repeats fold into the existing UNREAD row,
// incrementing its count instead of adding another line. Comments and votes
// use this; a new member or a payment does not, because each of those is worth
// seeing individually.
//
// Once a row is READ, nothing rolls into it again — the next event starts a
// fresh row. Without that rule, an admin who dealt with "7 new comments" would
// watch the same line silently climb to 8 and never be sure what was new.

const pool = require('../db');

// Kept here rather than as free strings at each call site, so a typo cannot
// invent a category that nothing knows how to display or filter.
const NOTIFY = {
  MEMBER_JOINED: 'member_joined',
  PROFILE_CREATED: 'profile_created',
  COMMENT_POSTED: 'comment_posted',
  ARTICLE_SUBMITTED: 'article_submitted',
  LISTING_SUBMITTED: 'listing_submitted',
  PAYMENT_CONFIRMED: 'payment_confirmed',
  NOMINATION: 'nomination',
  ENQUIRY: 'enquiry',
  LISTING_CLAIM: 'listing_claim',
  REVIEW_POSTED: 'review_posted',
  DEAF_JOB: 'deaf_job',
  BANNER_SUBMITTED: 'banner_submitted',
  SYSTEM_ERROR: 'system_error',
};

function clip(value, max) {
  const s = String(value == null ? '' : value).trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// `plural` is the wording used once a rolled-up row holds more than one
// event, with %n standing in for the count — for example
// "%n new comments awaiting approval". Only needed alongside a dedupeKey.
async function notifyAdmin({ type, message, detail, link, dedupeKey, paymentId, plural } = {}) {
  if (!type || !message) return { recorded: false, reason: 'incomplete' };

  const row = {
    type: clip(type, 40),
    message: clip(message, 500),
    detail: detail ? clip(detail, 2000) : null,
    link: link ? clip(link, 40) : null,
    key: dedupeKey ? clip(dedupeKey, 120) : null,
    paymentId: Number.isInteger(paymentId) ? paymentId : null,
  };

  if (!row.key) {
    await pool.query(
      `INSERT INTO admin_notifications
         (type, message, detail, link_section, related_payment_id, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, now())`,
      [row.type, row.message, row.detail, row.link, row.paymentId]
    );
    return { recorded: true, rolledUp: false };
  }

  // Roll up into the open row for this key if there is one. The partial unique
  // index on (dedupe_key) WHERE read = false is what makes this safe against
  // two requests arriving together — the second conflicts and updates rather
  // than creating a duplicate.
  const result = await pool.query(
    `INSERT INTO admin_notifications
       (type, message, detail, link_section, dedupe_key, event_count, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, 1, now())
     -- The predicate must MATCH the partial index exactly enough to imply it.
     -- "WHERE read = false" alone does not imply "read = false AND dedupe_key
     -- IS NOT NULL", and Postgres then refuses with 42P10, no unique
     -- constraint matching the ON CONFLICT specification.
     ON CONFLICT (dedupe_key) WHERE read = false AND dedupe_key IS NOT NULL
     DO UPDATE SET event_count  = admin_notifications.event_count + 1,
                   detail       = COALESCE(EXCLUDED.detail, admin_notifications.detail),
                   last_seen_at = now()
     RETURNING id, event_count`,
    [row.type, row.message, row.detail, row.link, row.key]
  );

  const { id, event_count: count } = result.rows[0];

  // THE MESSAGE HAS TO COUNT. Without this the row would keep the wording of
  // the first event — an admin would see "New comment awaiting approval" while
  // seven were waiting. The plural template is supplied by the caller because
  // only it knows what the thing is called.
  //
  // Deliberately NOT part of the upsert: the new wording depends on the count
  // the upsert just produced, which is not known until it returns.
  if (count > 1 && plural) {
    const worded = clip(String(plural).replace('%n', String(count)), 500);
    await pool.query('UPDATE admin_notifications SET message = $1 WHERE id = $2', [worded, id]);
  }
  return { recorded: true, rolledUp: count > 1, count };
}

// What every call site should use. Fire and forget.
function notifyAdminAsync(payload) {
  notifyAdmin(payload).catch((err) => {
    // Said out loud: a notification system that fails silently is worse than
    // none, because the absence of notifications reads as "nothing happened".
    console.error('[notify] could not record admin notification:', err.message);
  });
}

module.exports = { NOTIFY, notifyAdmin, notifyAdminAsync };
