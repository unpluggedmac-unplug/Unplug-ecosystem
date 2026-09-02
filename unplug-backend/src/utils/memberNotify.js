// TELLING A MEMBER SOMETHING HAPPENED (spec §10.17).
//
// The specification lists twenty-five events a member should hear about. The
// pieces to do that already existed — a notifications table, an email
// transport, and a notification_preferences row per member — but they were
// wired together at each call site, so every new event meant writing the same
// three steps again and getting the preference check right again.
//
// This is those three steps, once.
//
// ---------------------------------------------------------------------------
// IT NEVER THROWS, AND IT IS NEVER PART OF A TRANSACTION
// ---------------------------------------------------------------------------
//
// A notification is a side effect of something that already happened. If the
// email provider is down, or the member has no preferences row, or the address
// bounces, the thing itself still happened and must stand. A change request
// that rolled back because an email failed would leave an admin certain they
// had asked for changes and a member who was never asked.
//
// So: called AFTER the commit, errors are logged and swallowed, and the caller
// does not await it.

const pool = require('../db');
const { sendEmail } = require('./email');

// What a member has asked to receive.
//
// No row means the defaults, which are all on — a member who has never opened
// the preferences screen should still be told their submission needs work.
async function preferencesFor(userId) {
  try {
    const r = await pool.query(
      `SELECT web_enabled, email_enabled, notify_status_change
         FROM notification_preferences WHERE user_id = $1`,
      [userId]
    );
    if (!r.rows.length) return { web: true, email: true, statusChange: true };
    const p = r.rows[0];
    return {
      web: p.web_enabled !== false,
      email: p.email_enabled !== false,
      statusChange: p.notify_status_change !== false,
    };
  } catch (err) {
    // Unreadable preferences must not silence a notification. Defaulting to ON
    // risks an unwanted email; defaulting to OFF risks a member never learning
    // their submission is waiting on them, which is worse.
    console.error('[notify] preferences lookup failed, assuming defaults:', err.message);
    return { web: true, email: true, statusChange: true };
  }
}

// Send one. `isStatusChange` marks the events governed by notify_status_change —
// a submission moving through the review lifecycle is exactly that.
async function notifyMember({
  userId, type, title, body, linkUrl, email, isStatusChange = false,
}) {
  try {
    if (!userId || !type || !title || !body) return { sent: false, reason: 'incomplete' };

    const prefs = await preferencesFor(userId);
    if (isStatusChange && !prefs.statusChange) return { sent: false, reason: 'opted out' };

    let web = false;
    if (prefs.web) {
      await pool.query(
        `INSERT INTO notifications (user_id, type, title, body, link_url)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, type, String(title).slice(0, 200), body, linkUrl || null]
      );
      web = true;
    }

    let mailed = false;
    if (prefs.email && email && email.subject && email.text) {
      const to = await addressFor(userId);
      if (to) {
        await sendEmail({ to, subject: email.subject, text: email.text });
        mailed = true;
      }
    }

    return { sent: web || mailed, web, mailed };
  } catch (err) {
    console.error('[notify] could not notify member:', err.message);
    return { sent: false, reason: err.message };
  }
}

async function addressFor(userId) {
  const r = await pool.query('SELECT email FROM users WHERE id = $1', [userId]);
  return r.rows.length ? r.rows[0].email : null;
}

// Fire-and-forget, for a call site that has already committed and must not wait
// for an email round trip to answer the request.
function notifyMemberAsync(payload) {
  notifyMember(payload).catch((err) =>
    console.error('[notify] async notify failed:', err.message));
}

module.exports = { notifyMember, notifyMemberAsync, preferencesFor };
