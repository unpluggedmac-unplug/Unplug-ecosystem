const express = require('express');
const pool = require('../db');
const { requireRole } = require('../middleware/auth');
const { sendEmail } = require('../utils/email');
const marketing = require('../utils/emailMarketing');

const router = express.Router();

// Works out the recipient list for a given segment:
//   individuals — Directory members whose profile.type = 'individual'
//   businesses  — Directory members whose profile.type = 'business',
//                 PLUS anyone registered as an advertiser (Marketplace)
//   all         — the union of both
async function getRecipients(segment) {
  if (segment === 'individuals') {
    const result = await pool.query(
      `SELECT DISTINCT u.id, u.email FROM users u
       JOIN profiles p ON p.user_id = u.id
       WHERE p.type = 'individual'`
    );
    return result.rows;
  }
  if (segment === 'businesses') {
    const result = await pool.query(
      `SELECT DISTINCT u.id, u.email FROM users u
       JOIN profiles p ON p.user_id = u.id
       WHERE p.type = 'business'
       UNION
       SELECT DISTINCT u.id, u.email FROM users u
       JOIN advertisers a ON a.user_id = u.id`
    );
    return result.rows;
  }
  // 'all'
  const result = await pool.query(
    `SELECT DISTINCT u.id, u.email FROM users u
     JOIN profiles p ON p.user_id = u.id
     WHERE p.type IN ('individual', 'business')
     UNION
     SELECT DISTINCT u.id, u.email FROM users u
     JOIN advertisers a ON a.user_id = u.id`
  );
  return result.rows;
}

// Sends to `recipients` BATCH_SIZE at a time (concurrently within a batch,
// batches run one after another) rather than fully sequential — meaningfully
// faster for a large list without needing a real job queue. Runs after the
// response has already gone out (see POST / below), updating sent_count as
// it progresses so GET /history reflects real-time delivery status.
const BATCH_SIZE = 10;

// The campaign body is plain text an admin typed. Escaped before it goes into
// the HTML part, or a stray "<" swallows the rest of the message in every mail
// client that renders HTML.
function escapeForEmail(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function sendCampaignInBackground(campaignId, recipients, subject, body) {
  try {
    await pool.query(`UPDATE bulk_email_campaigns SET status = 'sending' WHERE id = $1`, [campaignId]);

    let sentCount = 0;
    let skipped = 0;
    for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
      const batch = recipients.slice(i, i + BATCH_SIZE);

      const results = await Promise.all(batch.map(async (r) => {
        // SUPPRESSION IS CHECKED HERE, one address at a time, at the moment of
        // sending — not when `recipients` was built.
        //
        // This send takes minutes. Somebody who unsubscribes during minute two
        // must not receive minute three, and a list filtered once at the start
        // cannot know that. Before this check existed there was no filtering at
        // all: this route mailed every matching member with no unsubscribe link
        // and no way for anyone to stop it.
        const suppressed = await marketing.isSuppressed(r.email);
        if (suppressed) return { skipped: true, reason: suppressed };

        // Sent through the marketing sender so the message carries an
        // unsubscribe link and the List-Unsubscribe headers that put a
        // one-click button in Gmail. A bulk message without them is one people
        // report as spam instead of leaving.
        await marketing.sendOne({
          campaignId: null, email: r.email, subject,
          text: body,
          html: `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#272626;">`
              + escapeForEmail(body).replace(/\n/g, '<br>') + '</div>',
        });
        return { skipped: false };
      }));

      sentCount += results.filter((x) => !x.skipped).length;
      skipped += results.filter((x) => x.skipped).length;
      await pool.query(`UPDATE bulk_email_campaigns SET sent_count = $1 WHERE id = $2`, [sentCount, campaignId]);
    }

    if (skipped) {
      console.log(`[bulk-email] Campaign ${campaignId}: skipped ${skipped} suppressed address(es)`);
    }

    await pool.query(`UPDATE bulk_email_campaigns SET status = 'completed' WHERE id = $1`, [campaignId]);
  } catch (err) {
    console.error(`[bulk-email] Campaign ${campaignId} failed:`, err);
    await pool.query(`UPDATE bulk_email_campaigns SET status = 'failed' WHERE id = $1`, [campaignId]).catch(() => {});
  }
}

// POST /admin/bulk-email — starts a campaign to one segment. Sends
// individually (not one big BCC) so recipients never see each other's
// addresses. Responds as soon as the campaign is created — actual sending
// happens in the background in batches (see sendCampaignInBackground above),
// so a large list can't time out the request. Poll GET /history to see
// sent_count/status progress.
router.post('/', requireRole('admin'), async (req, res, next) => {
  try {
    const { segment, subject, body } = req.body;
    if (!['individuals', 'businesses', 'all'].includes(segment)) {
      return res.status(400).json({ error: 'segment must be one of: individuals, businesses, all.' });
    }
    if (!subject || !body) {
      return res.status(400).json({ error: 'subject and body are required.' });
    }

    const recipients = await getRecipients(segment);

    const campaign = await pool.query(
      `INSERT INTO bulk_email_campaigns (sent_by, segment, subject, body, recipient_count, status, sent_count)
       VALUES ($1, $2, $3, $4, $5, 'queued', 0)
       RETURNING *`,
      [req.user.id, segment, subject, body, recipients.length]
    );

    sendCampaignInBackground(campaign.rows[0].id, recipients, subject, body);

    res.status(202).json({
      campaign: campaign.rows[0],
      recipientCount: recipients.length,
      message: 'Campaign queued — sending in the background. Check GET /admin/bulk-email/history for progress.',
    });
  } catch (err) {
    next(err);
  }
});

// GET /admin/bulk-email/history — past campaigns sent.
router.get('/history', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(`SELECT * FROM bulk_email_campaigns ORDER BY sent_at DESC LIMIT 50`);
    res.json({ campaigns: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /admin/bulk-email/preview?segment=individuals — how many people a
// segment would reach, without sending anything, so the admin can sanity
// check before firing off a real campaign.
router.get('/preview', requireRole('admin'), async (req, res, next) => {
  try {
    const segment = req.query.segment;
    if (!['individuals', 'businesses', 'all'].includes(segment)) {
      return res.status(400).json({ error: 'segment must be one of: individuals, businesses, all.' });
    }
    const recipients = await getRecipients(segment);
    res.json({ segment, recipientCount: recipients.length });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
