// The moderation view: what was flagged, why, and whether the filter is right.
//
// The most important screen here is not "spam caught". It is DISAGREEMENTS —
// the submissions the scorer called spam that a moderator then approved. Those
// are the readers this system is failing, and a spam filter nobody checks for
// false positives is a spam filter quietly losing people.

const express = require('express');
const pool = require('../db');
const { requireRole } = require('../middleware/auth');
const { logActivity } = require('./activityLog');
const scorer = require('../utils/spamScorer');
const classifier = require('../utils/spamClassifier');
const { issueFormToken } = require('../middleware/spamCheck');

const router = express.Router();

// GET /spam/form-token — public. Every form asks for one when it opens.
//
// This is what proves JavaScript ran and measures how long the form was open.
// Stateless and free to issue, so a bot requesting thousands achieves nothing
// but a thousand HMACs.
router.get('/form-token', (req, res) => {
  res.set('Cache-Control', 'no-store'); // a reused token is a lie about timing
  res.json({ formToken: issueFormToken() });
});

// GET /spam/overview — admin. Is this working, and is it wrong about anyone?
router.get('/overview', requireRole('admin'), async (req, res, next) => {
  try {
    const [counts, daily, disagreements, recent, limits] = await Promise.all([
      pool.query(
        `SELECT verdict, count(*)::int AS n FROM spam_assessments
          WHERE created_at > now() - INTERVAL '30 days' GROUP BY verdict`),
      pool.query(
        `SELECT date_trunc('day', created_at)::date AS day,
                count(*) FILTER (WHERE verdict = 'spam')::int    AS spam,
                count(*) FILTER (WHERE verdict = 'suspect')::int AS suspect,
                count(*) FILTER (WHERE verdict = 'clean')::int   AS clean
           FROM spam_assessments
          WHERE created_at > now() - INTERVAL '30 days'
          GROUP BY day ORDER BY day`),
      // The false positives. Deliberately its own query and its own number on
      // the screen, rather than a row buried in a table.
      pool.query(
        `SELECT count(*) FILTER (WHERE verdict IN ('spam','suspect') AND moderator_verdict = 'ham')::int AS wrongly_flagged,
                count(*) FILTER (WHERE verdict = 'clean' AND moderator_verdict = 'spam')::int            AS missed,
                count(*) FILTER (WHERE moderator_verdict IS NOT NULL)::int                               AS reviewed
           FROM spam_assessments WHERE created_at > now() - INTERVAL '90 days'`),
      pool.query(
        `SELECT a.*, u.email AS moderated_by_email
           FROM spam_assessments a
           LEFT JOIN users u ON u.id = a.moderated_by
          ORDER BY a.created_at DESC LIMIT 100`),
      scorer.thresholds(),
    ]);

    const byVerdict = Object.fromEntries(counts.rows.map((r) => [r.verdict, r.n]));
    const d = disagreements.rows[0];

    res.json({
      last30Days: {
        clean: byVerdict.clean || 0,
        suspect: byVerdict.suspect || 0,
        spam: byVerdict.spam || 0,
      },
      daily: daily.rows,
      accuracy: {
        reviewed: d.reviewed,
        wronglyFlagged: d.wrongly_flagged,
        missed: d.missed,
        // Spelled out because a percentage on its own invites the wrong
        // reading: this is only about the ones a person actually looked at.
        note: 'Of the submissions a moderator has ruled on, "wrongly flagged" '
            + 'were called spam or suspect by the filter and approved by a person. '
            + 'Those are the readers this is failing, and the number to watch.',
      },
      settings: limits,
      recent: recent.rows,
    });
  } catch (err) { next(err); }
});

// GET /spam/disagreements — admin. Just the false positives, newest first.
router.get('/disagreements', requireRole('admin'), async (req, res, next) => {
  try {
    const r = await pool.query(
      `SELECT * FROM spam_assessments
        WHERE verdict IN ('spam', 'suspect') AND moderator_verdict = 'ham'
        ORDER BY created_at DESC LIMIT 100`);
    res.json({ items: r.rows });
  } catch (err) { next(err); }
});

// POST /spam/:id/verdict — a moderator's ruling, which is also the training.
router.post('/:id/verdict', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const verdict = String(req.body.verdict || '').toLowerCase();
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'A valid assessment is required.' });
    if (!['ham', 'spam'].includes(verdict)) {
      return res.status(400).json({ error: 'Say whether this was spam or not ("spam" or "ham").' });
    }

    const result = await scorer.teach(id, verdict, req.user.id);
    if (!result.ok) return res.status(404).json({ error: result.error });

    logActivity(req.user.id, 'spam_verdict', `assessment #${id} marked ${verdict}`);
    res.json({ recorded: true });
  } catch (err) { next(err); }
});

// PATCH /spam/settings — sensitivity, without a deploy.
router.patch('/settings', requireRole('admin'), async (req, res, next) => {
  try {
    const changes = [];
    const suspect = Number(req.body.suspectThreshold);
    const reject = Number(req.body.rejectThreshold);

    if (req.body.suspectThreshold !== undefined) {
      if (!Number.isFinite(suspect) || suspect < 1 || suspect > 100) {
        return res.status(400).json({ error: 'The suspect threshold is a number between 1 and 100.' });
      }
      changes.push(['spam_suspect_threshold', String(Math.round(suspect))]);
    }
    if (req.body.rejectThreshold !== undefined) {
      if (!Number.isFinite(reject) || reject < 1 || reject > 100) {
        return res.status(400).json({ error: 'The reject threshold is a number between 1 and 100.' });
      }
      changes.push(['spam_reject_threshold', String(Math.round(reject))]);
    }
    // A reject bar below the suspect bar would mean everything suspect is also
    // rejected, which is not what anybody moving one slider intends.
    if (req.body.suspectThreshold !== undefined && req.body.rejectThreshold !== undefined
        && reject <= suspect) {
      return res.status(400).json({
        error: 'The reject threshold has to be higher than the suspect one, or everything flagged would be rejected.',
      });
    }
    if (req.body.autoReject !== undefined) {
      changes.push(['spam_autoreject_enabled', req.body.autoReject ? 'true' : 'false']);
    }
    if (!changes.length) return res.status(400).json({ error: 'Nothing to change.' });

    for (const [key, value] of changes) {
      await pool.query(
        `INSERT INTO settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [key, value]);
    }
    scorer.invalidate();
    logActivity(req.user.id, 'spam_settings_changed', changes.map((c) => c.join('=')).join(', '));
    res.json({ settings: await scorer.thresholds() });
  } catch (err) { next(err); }
});

// GET /spam/vocabulary — admin. What the classifier has learned.
//
// Worth being able to look at: this is how somebody notices it has decided
// that "Soweto" is a spam word before that starts costing real submissions.
router.get('/vocabulary', requireRole('admin'), async (req, res, next) => {
  try {
    res.json({
      tokens: await classifier.vocabulary(60),
      minEvidence: classifier.MIN_EVIDENCE,
      maxInfluence: classifier.MAX_INFLUENCE,
      note: 'Words the filter has learned from moderator decisions. A word is '
          + 'ignored until it has been seen at least ' + classifier.MIN_EVIDENCE
          + ' times, and the classifier can never move a score by more than '
          + classifier.MAX_INFLUENCE + ' points in total.',
    });
  } catch (err) { next(err); }
});

module.exports = router;
