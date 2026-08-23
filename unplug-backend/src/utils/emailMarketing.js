// Sending marketing email: consent in, suppression enforced, unsubscribe out.
//
// THE RULE THIS FILE EXISTS TO ENFORCE, and it has no exceptions:
//
//   NOTHING IS SENT TO A SUPPRESSED ADDRESS. Not by a campaign, not by an
//   automation, not by an admin who is sure it is fine. The check happens at
//   the moment of sending rather than when the recipient list is built, so
//   somebody who unsubscribes halfway through a send does not receive the rest
//   of it.
//
// TRANSACTIONAL MAIL DOES NOT COME THROUGH HERE. A password reset, an invoice,
// a download link — somebody who unsubscribed from the newsletter still needs
// those, and routing them through a marketing suppression list would strand
// people out of their own accounts. utils/email.js keeps doing that job, and
// the separation is deliberate.
//
// EVERY MESSAGE CARRIES A WAY OUT. A visible link, and the List-Unsubscribe
// headers that put a one-click button in Gmail and Apple Mail. Somebody who
// cannot find the link marks the message as spam instead, and enough of those
// takes the sending domain down — along with the password resets and the
// invoices.

const crypto = require('crypto');
const pool = require('../db');
const { sendEmail } = require('./email');

const SITE_URL = (process.env.SITE_URL || 'https://www.unplugnews.com').replace(/\/$/, '');
const API_URL = (process.env.PUBLIC_API_URL || 'https://unplug-ecosystem.onrender.com').replace(/\/$/, '');

function normalise(email) {
  return String(email || '').trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

// Records a subscription WITH its proof. source and ip are not optional in
// spirit: "why do you have my address" needs an answer better than "somebody
// typed it in somewhere".
async function subscribe({ email, listSlug = 'newsletter', source, ip, contactId }) {
  const address = normalise(email);
  if (!address.includes('@')) return { ok: false, error: 'That does not look like an email address.' };

  const list = await pool.query('SELECT id FROM email_lists WHERE slug = $1', [listSlug]);
  if (list.rowCount === 0) return { ok: false, error: 'No such list.' };

  // SUBSCRIBING AGAIN CLEARS A PREVIOUS UNSUBSCRIBE — but only for this list,
  // and only because the person has just asked. It does NOT clear a bounce or
  // a spam complaint: those are facts about whether mail can be delivered at
  // all, not about what somebody wants.
  await pool.query(
    `DELETE FROM email_suppressions WHERE email = $1 AND reason = 'unsubscribed'`, [address]);

  await pool.query(
    `INSERT INTO email_subscriptions
       (email, list_id, contact_id, status, consent_source, consent_at, consent_ip)
     VALUES ($1, $2, $3, 'subscribed', $4, now(), $5)
     ON CONFLICT (LOWER(email), list_id) DO UPDATE SET
       status = 'subscribed',
       consent_source = EXCLUDED.consent_source,
       consent_at = now(),
       consent_ip = EXCLUDED.consent_ip,
       unsubscribed_at = NULL,
       unsubscribe_reason = NULL,
       contact_id = COALESCE(email_subscriptions.contact_id, EXCLUDED.contact_id)`,
    [address, list.rows[0].id, contactId || null, source || 'unknown', ip || null]);

  return { ok: true };
}

// Stops the mail. Takes effect immediately and needs no account.
async function unsubscribe({ email, listSlug, reason = 'link', all = false }) {
  const address = normalise(email);
  if (!address) return { ok: false };

  if (all || !listSlug) {
    await pool.query(
      `UPDATE email_subscriptions
          SET status = 'unsubscribed', unsubscribed_at = now(), unsubscribe_reason = $2
        WHERE LOWER(email) = $1`, [address, reason]);
    // The global list, so a campaign that never checked the subscription table
    // still cannot reach them.
    await suppress(address, 'unsubscribed', `via ${reason}`);
  } else {
    await pool.query(
      `UPDATE email_subscriptions
          SET status = 'unsubscribed', unsubscribed_at = now(), unsubscribe_reason = $3
        WHERE LOWER(email) = $1
          AND list_id = (SELECT id FROM email_lists WHERE slug = $2)`,
      [address, listSlug, reason]);

    // Suppressed globally only once they are on no list at all. Somebody who
    // drops the newsletter but keeps competition news should keep getting
    // competition news.
    const remaining = await pool.query(
      `SELECT count(*)::int AS n FROM email_subscriptions
        WHERE LOWER(email) = $1 AND status = 'subscribed'`, [address]);
    if (remaining.rows[0].n === 0) await suppress(address, 'unsubscribed', 'left every list');
  }
  return { ok: true };
}

async function suppress(email, reason, detail) {
  await pool.query(
    `INSERT INTO email_suppressions (email, reason, detail) VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE SET reason = EXCLUDED.reason, detail = EXCLUDED.detail`,
    [normalise(email), reason, detail || null]);
}

async function isSuppressed(email) {
  const r = await pool.query('SELECT reason FROM email_suppressions WHERE email = $1', [normalise(email)]);
  return r.rowCount > 0 ? r.rows[0].reason : null;
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

// Per-message, random, and stored — not derived from the address. A derived
// token means one leaked unsubscribe link reveals the scheme and lets anybody
// unsubscribe anybody.
function newToken() {
  return crypto.randomBytes(24).toString('base64url');
}

async function sendForToken(token) {
  const r = await pool.query(
    `SELECT s.*, c.name AS campaign_name FROM email_sends s
       LEFT JOIN email_campaigns c ON c.id = s.campaign_id
      WHERE s.token = $1`, [token]);
  return r.rowCount ? r.rows[0] : null;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

// Who a campaign would go to, and who it would skip. Used by the preview so an
// admin sees the real number before pressing send rather than afterwards.
async function audienceFor(listId) {
  const r = await pool.query(
    `SELECT s.email,
            (sup.email IS NOT NULL) AS suppressed,
            sup.reason AS suppression_reason
       FROM email_subscriptions s
       LEFT JOIN email_suppressions sup ON sup.email = LOWER(s.email)
      WHERE s.list_id = $1 AND s.status = 'subscribed'
      ORDER BY s.email`, [listId]);
  return {
    willSend: r.rows.filter((x) => !x.suppressed).map((x) => x.email),
    willSkip: r.rows.filter((x) => x.suppressed),
  };
}

// Sends one message, with the way out attached.
//
// Returns the email_sends row. Never throws: one bad address must not stop a
// campaign of four hundred.
async function sendOne({ campaignId, email, subject, html, text }) {
  const address = normalise(email);
  const token = newToken();

  const record = await pool.query(
    `INSERT INTO email_sends (campaign_id, email, token, status) VALUES ($1, $2, $3, 'queued')
     RETURNING *`, [campaignId, address, token]);
  const send = record.rows[0];

  // CHECKED HERE, at the moment of sending — not when the list was built.
  // A campaign to four hundred people takes minutes; somebody who unsubscribes
  // in minute two must not receive minute three.
  const suppressed = await isSuppressed(address);
  if (suppressed) {
    await pool.query(
      `UPDATE email_sends SET status = 'skipped', skip_reason = $2 WHERE id = $1`,
      [send.id, suppressed]);
    return { ...send, status: 'skipped', skip_reason: suppressed };
  }

  const unsubscribeUrl = `${API_URL}/email/unsubscribe/${token}`;
  try {
    await sendEmail({
      to: address,
      subject,
      text: `${text}\n\n---\nTo stop receiving these: ${unsubscribeUrl}`,
      html: html ? withUnsubscribe(html, unsubscribeUrl, token) : undefined,
      // RFC 2369 and RFC 8058. These are what put a one-click Unsubscribe
      // button next to the sender name in Gmail and Apple Mail — the button
      // people press INSTEAD of the spam button, which is the difference
      // between losing a subscriber and losing the domain's reputation.
      headers: {
        'List-Unsubscribe': `<${unsubscribeUrl}>, <mailto:unsubscribe@unplugnews.com?subject=unsubscribe>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });
    await pool.query(
      `UPDATE email_sends SET status = 'sent', sent_at = now() WHERE id = $1`, [send.id]);
    return { ...send, status: 'sent' };
  } catch (err) {
    await pool.query(
      `UPDATE email_sends SET status = 'failed', error = $2 WHERE id = $1`,
      [send.id, String(err.message).slice(0, 500)]);
    return { ...send, status: 'failed', error: err.message };
  }
}

// Adds the footer and the open pixel to composed HTML.
function withUnsubscribe(html, unsubscribeUrl, token) {
  const footer = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:24px;">
      <tr><td align="center" style="font-family:Arial,sans-serif;font-size:12px;color:#6b6b6b;padding:16px 24px;">
        You are receiving this because you subscribed at unplugnews.com.<br>
        <a href="${unsubscribeUrl}" style="color:#6b6b6b;text-decoration:underline;">Unsubscribe</a> &nbsp;·&nbsp;
        <a href="${SITE_URL}/?p=preferences" style="color:#6b6b6b;text-decoration:underline;">Choose what you get</a>
      </td></tr>
    </table>`;

  // The open pixel. Honest about what it is: a 1x1 image whose alt text is
  // empty and which is marked presentational, so a screen reader ignores it
  // rather than announcing a mystery graphic. Plenty of clients block it, and
  // the reporting says so rather than pretending the open rate is exact.
  const pixel = `<img src="${API_URL}/email/o/${token}.gif" width="1" height="1" alt="" role="presentation" style="display:block;border:0;">`;

  return html.includes('</body>')
    ? html.replace('</body>', `${footer}${pixel}</body>`)
    : `${html}${footer}${pixel}`;
}

// Rewrites links so clicks can be counted.
//
// Only http(s) links are wrapped. The unsubscribe link is deliberately NOT
// wrapped: it has to work even if the tracking route is broken, because a
// broken unsubscribe is the failure that turns into spam complaints.
function wrapLinks(html, token) {
  return html.replace(/href="(https?:\/\/[^"]+)"/g, (match, url) => {
    if (url.includes('/email/unsubscribe/')) return match;
    return `href="${API_URL}/email/c/${token}?u=${encodeURIComponent(url)}"`;
  });
}

module.exports = {
  subscribe, unsubscribe, suppress, isSuppressed,
  audienceFor, sendOne, withUnsubscribe, wrapLinks,
  newToken, sendForToken, normalise,
};
