// A classifier that learns this site's spam from what moderators decide.
//
// WHY LEARN RATHER THAN LIST. A hand-written keyword list encodes what spam
// looked like on the day somebody wrote it, and it never improves. This counts
// how often each word appears in submissions a moderator REJECTED versus
// APPROVED, which means it learns the spam that actually arrives here — and
// this site's spam is specific. A fake Top 10 nomination and a fake contact
// enquiry share vocabulary with each other and with almost nothing else.
//
// It also learns the site's HAM, which matters more. Words like "nomination",
// "Soweto", "matric", "gogo" appear constantly in genuine submissions. Once
// there is any history, a message containing them is pulled towards clean, and
// that protects exactly the readers a generic filter would misjudge.
//
// IT STARTS SILENT. With no history every word is unknown, the classifier
// returns zero, and only the hand-written signals apply. It earns its
// influence — capped, see below — as moderators use the site.

const pool = require('../db');

// Words shorter than this are noise ("the", "and", "a") and words longer are
// usually URLs or gibberish that will never repeat.
const MIN_TOKEN = 3;
const MAX_TOKEN = 40;

// How many times a word must have been seen before its opinion counts. One
// spam message mentioning "Durban" must not make Durban a spam word.
const MIN_EVIDENCE = 5;

// The most the classifier may contribute, in either direction.
//
// CAPPED ON PURPOSE, and the cap is the safety feature. A classifier trained
// on a few hundred decisions is confident long before it is right, and an
// uncapped one would eventually overrule every hand-written signal on the
// strength of a coincidence. It can push a submission towards suspect; it
// cannot condemn one by itself.
const MAX_INFLUENCE = 30;

// The most informative words in a message, rather than all of them: a long
// message would otherwise drown out a short one purely by having more words.
const TOKENS_CONSIDERED = 20;

function tokenise(text) {
  return [...new Set(
    String(text || '')
      .toLowerCase()
      // Keeps letters from any language: this audience writes in English,
      // Afrikaans, isiZulu, Sesotho and more, and a filter that only
      // understood ASCII would treat half of them as unfamiliar.
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= MIN_TOKEN && t.length <= MAX_TOKEN)
  )];
}

// How spammy a message looks, from -MAX_INFLUENCE (clean) to +MAX_INFLUENCE.
async function score(text) {
  const tokens = tokenise(text);
  if (!tokens.length) return { points: 0, tokensUsed: 0, topTokens: [] };

  let rows;
  try {
    const r = await pool.query(
      `SELECT token, spam_count, ham_count FROM spam_tokens
        WHERE token = ANY($1) AND (spam_count + ham_count) >= $2`,
      [tokens, MIN_EVIDENCE]);
    rows = r.rows;
  } catch (err) {
    // No history, no opinion. A classifier that cannot read its table must not
    // stop a submission being accepted.
    console.error('[spam] classifier lookup failed:', err.message);
    return { points: 0, tokensUsed: 0, topTokens: [] };
  }
  if (!rows.length) return { points: 0, tokensUsed: 0, topTokens: [] };

  // Totals, so a word's rate is judged against how much of each kind has been
  // seen overall. Without this, a site with mostly-ham history would call
  // every word hammy simply because ham is more common.
  const totals = await pool.query(
    `SELECT COALESCE(sum(spam_count), 0)::float AS spam, COALESCE(sum(ham_count), 0)::float AS ham
       FROM spam_tokens`);
  const totalSpam = Math.max(1, Number(totals.rows[0].spam));
  const totalHam = Math.max(1, Number(totals.rows[0].ham));

  const scored = rows.map((row) => {
    // Laplace smoothing: the +1s stop a word seen only in spam from producing
    // an infinite ratio, which is how a single coincidence becomes a
    // permanent rule.
    const pSpam = (Number(row.spam_count) + 1) / (totalSpam + 2);
    const pHam = (Number(row.ham_count) + 1) / (totalHam + 2);
    return { token: row.token, weight: Math.log(pSpam / pHam) };
  });

  // The most opinionated words, in either direction.
  scored.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
  const used = scored.slice(0, TOKENS_CONSIDERED);
  const sum = used.reduce((acc, t) => acc + t.weight, 0);

  // Squashed into the allowed range rather than scaled linearly, so a long
  // run of mildly spammy words cannot add up to a certainty.
  const points = Math.round(MAX_INFLUENCE * Math.tanh(sum / 6));

  return {
    points,
    tokensUsed: used.length,
    topTokens: used.slice(0, 5).map((t) => `${t.token}${t.weight > 0 ? '+' : ''}${t.weight.toFixed(1)}`),
  };
}

// Records what a moderator decided, so the next message benefits from it.
//
// Idempotent per assessment: the caller passes the previous verdict when a
// decision is being CHANGED, and the old counts are undone first. Without
// that, a moderator correcting a mistake would teach the classifier both
// answers and the correction would make things worse rather than better.
async function learn(text, verdict, previousVerdict) {
  const tokens = tokenise(text);
  if (!tokens.length) return 0;
  if (verdict !== 'spam' && verdict !== 'ham') return 0;

  const spamDelta = (verdict === 'spam' ? 1 : 0) - (previousVerdict === 'spam' ? 1 : 0);
  const hamDelta = (verdict === 'ham' ? 1 : 0) - (previousVerdict === 'ham' ? 1 : 0);
  if (spamDelta === 0 && hamDelta === 0) return 0;

  await pool.query(
    // GREATEST on BOTH branches. On the update it stops a reversed decision
    // driving a count below zero; on the insert it stops a reversal of
    // something that was never recorded creating a row at -1, which would
    // poison that word's ratio permanently.
    `INSERT INTO spam_tokens (token, spam_count, ham_count)
     SELECT t, GREATEST(0, $2), GREATEST(0, $3) FROM unnest($1::text[]) AS t
     ON CONFLICT (token) DO UPDATE SET
       -- GREATEST keeps a count from going negative if a decision is reversed
       -- more times than it was recorded, which would otherwise poison the
       -- word for good.
       spam_count = GREATEST(0, spam_tokens.spam_count + $2),
       ham_count  = GREATEST(0, spam_tokens.ham_count + $3),
       updated_at = now()`,
    [tokens, spamDelta, hamDelta]);

  return tokens.length;
}

// What the classifier currently believes, for the admin screen. Being able to
// look at this is what makes it possible to notice it has learned something
// silly before it starts acting on it.
async function vocabulary(limit = 40) {
  const r = await pool.query(
    `SELECT token, spam_count, ham_count
       FROM spam_tokens
      WHERE (spam_count + ham_count) >= $2
      ORDER BY (spam_count + ham_count) DESC
      LIMIT $1`, [limit, MIN_EVIDENCE]);
  return r.rows;
}

module.exports = {
  score, learn, tokenise, vocabulary,
  MIN_EVIDENCE, MAX_INFLUENCE, TOKENS_CONSIDERED,
};
