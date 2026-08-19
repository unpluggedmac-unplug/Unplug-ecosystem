// Writing analytics down. One place, so every caller records the same shape.
//
// EVERY FUNCTION HERE SWALLOWS ITS OWN ERRORS. Analytics is a bystander: it
// must never be the reason a page fails to load, an article fails to submit,
// or a payment fails to confirm. A lost row is a gap in a report; a thrown
// error here would be a customer looking at a failure on a screen where they
// just paid money.

const pool = require('../db');

// Recorded once, on the session's FIRST request, and never touched again.
//
// A visit's source is a fact about how it began. Someone who arrives from
// Instagram and then opens four articles came from Instagram — updating the
// source on each later request would rewrite that to whatever the last page
// happened to look like, and internal navigation would end up filed as its own
// traffic source. The COALESCE columns below are the ones that must not move.
async function touchSession({ sessionId, visitorId, pagePath, context, userId, isPageView }) {
  if (!sessionId || !visitorId) return;
  try {
    // A visitor id seen against any EARLIER session means they have been here
    // before. Checked before the insert, or the row about to be written would
    // count as its own prior visit.
    const seen = await pool.query(
      'SELECT 1 FROM analytics_sessions WHERE visitor_id = $1 AND session_id <> $2 LIMIT 1',
      [visitorId, sessionId]
    );
    const isReturning = seen.rowCount > 0;

    await pool.query(
      `INSERT INTO analytics_sessions
         (session_id, visitor_id, is_returning, source, medium, campaign, referrer_host,
          landing_path, entry_path, exit_path, device_type, browser, os, country, user_id,
          page_count, event_count, started_at, last_seen_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$8,$9,$10,$11,$12,$13,
               $14, 1, now(), now())
       ON CONFLICT (session_id) DO UPDATE SET
         last_seen_at = now(),
         -- The last page seen IS the exit page, until a later one replaces it.
         exit_path    = COALESCE(EXCLUDED.exit_path, analytics_sessions.exit_path),
         page_count   = analytics_sessions.page_count + $14,
         event_count  = analytics_sessions.event_count + 1,
         -- Attribution and device belong to how the visit STARTED. COALESCE
         -- keeps the original and only fills a gap that was never set.
         source        = COALESCE(analytics_sessions.source, EXCLUDED.source),
         medium        = COALESCE(analytics_sessions.medium, EXCLUDED.medium),
         campaign      = COALESCE(analytics_sessions.campaign, EXCLUDED.campaign),
         referrer_host = COALESCE(analytics_sessions.referrer_host, EXCLUDED.referrer_host),
         entry_path    = COALESCE(analytics_sessions.entry_path, EXCLUDED.entry_path),
         device_type   = COALESCE(analytics_sessions.device_type, EXCLUDED.device_type),
         browser       = COALESCE(analytics_sessions.browser, EXCLUDED.browser),
         os            = COALESCE(analytics_sessions.os, EXCLUDED.os),
         country       = COALESCE(analytics_sessions.country, EXCLUDED.country),
         -- user_id is the exception: a visit that starts anonymous and then
         -- signs in must gain the account, never lose it.
         user_id       = COALESCE(EXCLUDED.user_id, analytics_sessions.user_id)`,
      [
        sessionId, visitorId, isReturning,
        context.source, context.medium, context.campaign, context.referrerHost,
        pagePath || null,
        context.deviceType, context.browser, context.os, context.country,
        userId || null,
        isPageView ? 1 : 0,
      ]
    );
  } catch (err) {
    console.error('[analytics] session write failed:', err.message);
  }
}

async function recordEvent({ sessionId, visitorId, eventName, pagePath, entityType, entityId, userId, valueCents, label }) {
  if (!eventName) return;
  try {
    await pool.query(
      `INSERT INTO analytics_events
         (session_id, visitor_id, event_name, page_path, entity_type, entity_id, user_id, value_cents, label)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [sessionId || null, visitorId || null, eventName,
        pagePath ? String(pagePath).slice(0, 500) : null,
        entityType || null,
        Number.isInteger(entityId) ? entityId : null,
        userId || null,
        Number.isInteger(valueCents) ? valueCents : null,
        // A tag, or what somebody typed into search. Bounded to the column
        // rather than rejected: a long search string is still a real signal.
        label ? String(label).trim().slice(0, 160) : null]
    );
  } catch (err) {
    console.error('[analytics] event write failed:', err.message);
  }
}

// A CONVERSION THE SERVER PERFORMED. Signups, submissions and payments are
// recorded here rather than from the browser, because only the server knows
// they actually succeeded — a browser can be told to report a payment that
// never happened, and revenue that can be fabricated is not revenue data.
//
// There is no session id at this point: the request that confirms a payment is
// usually not the visit that caused it. The event carries the user, and the
// funnel report joins back through that user's sessions to find the visit
// that brought them.
async function recordConversion({ userId, eventName, entityType, entityId, valueCents }) {
  return recordEvent({
    sessionId: null, visitorId: null,
    eventName, pagePath: null,
    entityType, entityId, userId,
    valueCents,
  });
}

// Fire-and-forget, for call sites on a request path that must not wait for a
// write to a reporting table.
function recordConversionAsync(args) {
  recordConversion(args).catch((err) => console.error('[analytics] conversion failed:', err.message));
}

// A CONFIRMED PAYMENT, RECORDED EXACTLY ONCE.
//
// applyPaymentEffect can legitimately run more than once for the same payment
// — a cart re-confirmed, an admin re-approving after fixing something. Every
// effect it performs is written to be idempotent, and revenue has to be too:
// counting one R95 article twice does not produce a slightly wrong report, it
// produces a revenue figure nobody can trust.
//
// The payment id is the identity, so the check is exact rather than a
// heuristic about timing.
async function recordPaymentOnce(payment) {
  try {
    if (!payment || payment.status !== 'confirmed' || !payment.id) return;

    const already = await pool.query(
      `SELECT 1 FROM analytics_events
        WHERE event_name = 'payment' AND entity_type = 'payment' AND entity_id = $1
        LIMIT 1`,
      [payment.id]
    );
    if (already.rowCount > 0) return;

    // Stored in cents, from the NUMERIC column, so nothing is lost to floating
    // point on the way in.
    const cents = Math.round(Number(payment.amount || 0) * 100);
    await recordEvent({
      sessionId: null, visitorId: null,
      eventName: 'payment',
      pagePath: null,
      entityType: 'payment',
      entityId: payment.id,
      userId: payment.user_id || null,
      valueCents: Number.isFinite(cents) ? cents : null,
    });
  } catch (err) {
    console.error('[analytics] payment record failed:', err.message);
  }
}

module.exports = { touchSession, recordEvent, recordConversion, recordConversionAsync, recordPaymentOnce };

