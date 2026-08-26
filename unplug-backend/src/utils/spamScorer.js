// Scoring one submission: the signals, the classifier, and a verdict.
//
// WHAT A VERDICT MEANS, and it is not what the words suggest:
//
//   clean    goes into the moderation queue as normal
//   suspect  goes into the queue, marked, sorted to the bottom
//   spam     goes into the queue, marked — and ONLY auto-rejects if an admin
//            has deliberately switched that on, which is off by default
//
// So the default behaviour of this entire system is: nothing is refused,
// nothing is deleted, and the queue is sorted so a moderator reads the real
// submissions first. That is the honest description of the value here.
// Everything on this site already goes to a queue; spam was never reaching
// readers. What it was doing was burying a nomination from somebody's
// grandmother behind forty casino adverts.
//
// WHY NOT SIMPLY REFUSE THE OBVIOUS ONES. Because "obvious" is a judgement
// made by code that has never met the person submitting. A South African
// community magazine receives submissions from people typing on cheap phones,
// in four languages, often in capitals, often very short. Every one of those
// traits appears on somebody's list of spam indicators. The cost of being
// wrong is a real entry vanishing with nobody ever knowing — not a moderator
// spending three extra seconds.

const pool = require('../db');
const { runSignals, textOf } = require('./spamSignals');
const classifier = require('./spamClassifier');

const DEFAULTS = { suspect: 40, reject: 80, autoReject: false };

// Thresholds live in the existing settings table so an admin can move them
// without a deploy. Cached briefly: this runs on every public submission and
// the values change perhaps monthly.
let cache = { at: 0, value: null };
const CACHE_MS = 30 * 1000;

async function thresholds() {
  if (cache.value && Date.now() - cache.at < CACHE_MS) return cache.value;
  const value = { ...DEFAULTS };
  try {
    const r = await pool.query(
      `SELECT key, value FROM settings WHERE key IN
        ('spam_suspect_threshold', 'spam_reject_threshold', 'spam_autoreject_enabled')`);
    for (const row of r.rows) {
      if (row.key === 'spam_suspect_threshold') value.suspect = Number(row.value) || DEFAULTS.suspect;
      if (row.key === 'spam_reject_threshold') value.reject = Number(row.value) || DEFAULTS.reject;
      if (row.key === 'spam_autoreject_enabled') value.autoReject = String(row.value) === 'true';
    }
  } catch (err) {
    // The defaults are the safe end. A settings table that cannot be read must
    // not make the filter stricter than somebody chose.
    console.error('[spam] could not read thresholds:', err.message);
  }
  cache = { at: Date.now(), value };
  return value;
}

function invalidate() { cache = { at: 0, value: null }; }

// Judges a submission. NEVER THROWS: the worst it does on failure is call
// something clean, because a contact form that returns 500 because the spam
// filter had a bad day is a worse outcome than a spam message in a queue.
//
//   submission = {
//     targetType, fields, elapsedMs, jsTokenValid, ip
//   }
async function assess(submission) {
  try {
    const signals = runSignals(submission);
    let score = signals.reduce((sum, s) => sum + s.points, 0);

    const text = textOf(submission.fields);
    const learned = await classifier.score(text);
    if (learned.points !== 0) {
      score += learned.points;
      signals.push({
        name: 'learned',
        points: learned.points,
        detail: learned.tokensUsed
          ? `from ${learned.tokensUsed} known words: ${learned.topTokens.join(' ')}`
          : 'no history yet',
      });
    }

    score = Math.max(0, Math.min(100, score));
    const limits = await thresholds();
    const verdict = score >= limits.reject ? 'spam'
      : score >= limits.suspect ? 'suspect' : 'clean';

    return {
      score, verdict, signals,
      // Only ever true when an admin has switched auto-rejection on AND the
      // score cleared the higher bar. Both conditions, deliberately.
      shouldAutoReject: verdict === 'spam' && limits.autoReject,
      thresholds: limits,
    };
  } catch (err) {
    console.error('[spam] assessment failed, treating as clean:', err.message);
    return { score: 0, verdict: 'clean', signals: [], shouldAutoReject: false, thresholds: DEFAULTS };
  }
}

// Writes the assessment down, so a moderator can see why something was flagged
// and the classifier has something to learn from later.
//
// Returns the assessment id, or null. Failure to record must not fail the
// submission — the reader's message still went through.
async function record(assessment, submission) {
  try {
    const text = textOf(submission.fields);
    const r = await pool.query(
      `INSERT INTO spam_assessments
         (target_type, target_id, score, verdict, signals, sample, email, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [submission.targetType, submission.targetId || null,
       assessment.score, assessment.verdict, JSON.stringify(assessment.signals),
       text.slice(0, 2000),
       (submission.fields && submission.fields.email) || null,
       submission.ip || null]);
    return r.rows[0].id;
  } catch (err) {
    console.error('[spam] could not record assessment:', err.message);
    return null;
  }
}

// A moderator's decision, which is both the correction and the training data.
async function teach(assessmentId, moderatorVerdict, adminUserId) {
  const existing = await pool.query(
    'SELECT sample, moderator_verdict FROM spam_assessments WHERE id = $1', [assessmentId]);
  if (existing.rowCount === 0) return { ok: false, error: 'That assessment no longer exists.' };

  const row = existing.rows[0];
  // The previous verdict is passed so a changed decision UNDOES the old
  // lesson. Without that, a moderator fixing a mistake teaches the classifier
  // both answers and makes it worse rather than better.
  await classifier.learn(row.sample, moderatorVerdict, row.moderator_verdict);

  await pool.query(
    `UPDATE spam_assessments
        SET moderator_verdict = $2, moderated_by = $3, moderated_at = now()
      WHERE id = $1`, [assessmentId, moderatorVerdict, adminUserId || null]);

  return { ok: true };
}

module.exports = { assess, record, teach, thresholds, invalidate, DEFAULTS };
