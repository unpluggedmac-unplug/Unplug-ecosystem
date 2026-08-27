// "SEEN AND HEARD BY UNPLUG" SHARE CARDS.
//
// Someone we featured designs a card to post on their own accounts. They see
// only a WATERMARKED preview until an admin approves it — nothing carrying the
// masthead goes out without an editor having seen it.
//
// The gate is the whole point, so it is enforced HERE and not in the page: the
// clean card is drawn from fields this API will only hand over once the record
// says 'approved'. A page can be edited by whoever is looking at it; a server
// check cannot.

const express = require('express');
const pool = require('../db');
const { requireRole, attachUser } = require('../middleware/auth');
const { spamCheck } = require('../middleware/spamCheck');
const { publicSubmitLimiter } = require('../middleware/rateLimit');
const honeypot = require('../middleware/honeypot');
const { sendEmail } = require('../utils/email');
const { logActivity } = require('./activityLog');

const router = express.Router();

const SITE_URL = process.env.SITE_URL || 'https://www.unplugnews.com';
const FORMATS = ['post', 'story'];

const trim = (v, max) => (v === null || v === undefined ? null : String(v).trim().slice(0, max) || null);

// THE PHOTO MUST BE A FILE WE STORED, not any address somebody sends.
//
// This URL is drawn onto a card carrying the masthead and is handed back by a
// public endpoint. Accepting an arbitrary URL would let anyone put any picture
// on the internet onto an Unplug card, and would make this API fetch whatever
// they named. It has to be a file that came through our own upload — which
// requires a member account, which is the whole point of gating the photo.
const { isPublicStorageUrl } = require('./uploads');

function photoFrom(body, user) {
  const url = trim(body.photoUrl, 500);
  if (!url) return { url: null, x: 0, y: 0, zoom: 1, userId: null };

  // A photo needs an account. The card itself does not, and that stays true —
  // somebody we just featured should not meet a login screen.
  if (!user) {
    return { status: 401, error: 'Sign in as an Unplug member to add a photo to your card.' };
  }
  if (!isPublicStorageUrl(url)) {
    return { status: 400, error: 'That photo was not uploaded here. Please choose the picture again.' };
  }

  // Bounded to what the design can actually render. The offsets are fractions
  // of the circle, so anything beyond half a diameter has pushed the picture
  // entirely out of view.
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0));
  return {
    url,
    x: clamp(body.photoOffsetX, -1, 1),
    y: clamp(body.photoOffsetY, -1, 1),
    zoom: Math.min(4, Math.max(1, Number(body.photoZoom) || 1)),
    userId: user.id,
  };
}

// POST /share-cards — public. Anyone can submit; nobody can publish.
// attachUser, NOT requireAuth: the route stays public so anybody featured can
// make a text-only card, but a member who IS signed in is recognised so their
// photo can be accepted.
router.post('/', publicSubmitLimiter, attachUser, honeypot, spamCheck('share card'), async (req, res, next) => {
  try {
    const name = trim(req.body.name, 160);
    const email = (req.body.submitterEmail || '').trim().toLowerCase();

    if (!name) return res.status(400).json({ error: 'Please enter the name that should appear on the card.' });
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'A valid email address is required — it is where the approved card is sent.' });
    }

    const format = FORMATS.includes(req.body.format) ? req.body.format : 'post';

    const photo = photoFrom(req.body, req.user);
    if (photo.error) return res.status(photo.status || 400).json({ error: photo.error });

    const result = await pool.query(
      `INSERT INTO share_cards (name, role_line, quote, category, format, submitter_email,
                                photo_url, photo_offset_x, photo_offset_y, photo_zoom, photo_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id, review_token`,
      [name, trim(req.body.roleLine, 160), trim(req.body.quote, 400),
        trim(req.body.category, 80), format, email,
        photo.url, photo.x, photo.y, photo.zoom, photo.userId]
    );

    res.status(201).json({
      id: result.rows[0].id,
      message: 'Sent for approval. We will email you the finished card once it has been checked — usually within a day.',
    });
  } catch (err) {
    next(err);
  }
});

router.get('/admin/all', requireRole('admin'), async (req, res, next) => {
  try {
    const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : null;
    const r = await pool.query(
      `SELECT s.*, u.email AS reviewed_by_email
         FROM share_cards s
         LEFT JOIN users u ON u.id = s.reviewed_by
        ${status ? 'WHERE s.status = $1' : ''}
        ORDER BY s.created_at DESC LIMIT 200`,
      status ? [status] : []
    );
    res.json({ cards: r.rows });
  } catch (err) {
    next(err);
  }
});

// GET /share-cards/:token — public, and the ONLY way to obtain a clean card.
//
// Refuses anything not yet approved. A pending card returns its status so the
// page can say "still being checked" rather than showing a bare 404, but it
// NEVER returns the fields needed to draw the unwatermarked version.
router.get('/:token', async (req, res, next) => {
  try {
    const token = String(req.params.token || '');
    // Checked before it reaches the query so a malformed token is a clean 404
    // rather than a database error about uuid syntax.
    if (!/^[0-9a-f-]{36}$/i.test(token)) {
      return res.status(404).json({ error: 'That card link is not valid.' });
    }

    const r = await pool.query(
      `SELECT id, name, role_line, quote, category, format, status,
              photo_url, photo_offset_x, photo_offset_y, photo_zoom
         FROM share_cards WHERE review_token = $1`,
      [token]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'That card link is not valid.' });

    const card = r.rows[0];
    if (card.status !== 'approved') {
      return res.status(403).json({
        status: card.status,
        error: card.status === 'pending'
          ? 'This card is still being checked. We will email you the moment it is approved.'
          : 'This card was not approved.',
      });
    }
    res.json({ card });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

// Shared by approve and reject so the two cannot drift apart on the one thing
// that matters: a decision is made ONCE. The WHERE clause carries
// status = 'pending', so a second click changes nothing and says so.
async function decide(req, res, next, decision) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'A valid id is required.' });

    const r = await pool.query(
      `UPDATE share_cards
          SET status = $1, reviewed_at = now(), reviewed_by = $2
        WHERE id = $3 AND status = 'pending'
        RETURNING *`,
      [decision, req.user.id, id]
    );
    if (r.rows.length === 0) {
      const existing = await pool.query('SELECT status FROM share_cards WHERE id = $1', [id]);
      if (existing.rows.length === 0) return res.status(404).json({ error: 'That card no longer exists.' });
      return res.status(409).json({ error: `Already handled — this card was ${existing.rows[0].status}.` });
    }
    const card = r.rows[0];

    // Sent best-effort. The decision is recorded either way: an email that
    // fails must not leave the card stuck in a state where it looks unreviewed
    // and gets decided a second time.
    const link = `${SITE_URL}/unplug-magazine?p=card&token=${card.review_token}`;
    const mail = decision === 'approved'
      ? {
        subject: 'Your Unplug card is ready',
        text: `Hi ${card.name},\n\n`
          + 'Your "Seen and Heard by Unplug" card has been approved and is ready to download and share.\n\n'
          + `${link}\n\n`
          + 'Open that link and press Download. Post it wherever you like — and thank you for letting us tell your story.\n\n'
          + 'The Unplug team',
      }
      : {
        subject: 'About your Unplug card',
        text: `Hi ${card.name},\n\n`
          + 'Thank you for making a card. We are not able to approve this one — usually that is because the wording '
          + 'or the details need a change on our side rather than anything you did wrong.\n\n'
          + 'If you think this was a mistake, or you would like help putting one together, just reply to this email '
          + 'and a person will come back to you.\n\n'
          + 'The Unplug team',
      };

    let emailed = true;
    try {
      await sendEmail({ to: card.submitter_email, subject: mail.subject, text: mail.text });
    } catch (e) {
      emailed = false;
      console.error('[share-cards] could not email the submitter:', e.message);
    }

    await logActivity(req.user.id, `share_card_${decision}`,
      `${decision === 'approved' ? 'Approved' : 'Rejected'} share card for ${card.name}`).catch(() => {});

    res.json({
      card, emailed,
      message: decision === 'approved'
        ? (emailed ? `Approved — the card has been emailed to ${card.submitter_email}.`
          : `Approved, but the email could not be sent. Send them this link: ${link}`)
        : (emailed ? 'Rejected — they have been sent a short note.'
          : 'Rejected, but the note could not be emailed.'),
    });
  } catch (err) {
    next(err);
  }
}

router.patch('/admin/:id/approve', requireRole('admin'), (req, res, next) => decide(req, res, next, 'approved'));
router.patch('/admin/:id/reject', requireRole('admin'), (req, res, next) => decide(req, res, next, 'rejected'));

module.exports = router;
