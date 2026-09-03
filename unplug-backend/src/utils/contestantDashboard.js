// What a contestant sees about their own entry (spec §8.5).
//
// §8.5 is unusually specific, and the emphasis is the spec's own:
//
//   "The contestant must see the: EXACT NUMBER OF VERIFIED VOTES"
//
// plus their contestant code, the online/bulk split, their current ranking, the
// competition's closing date and its status.
//
// WHY THE COUNT HERE IS ALREADY "VERIFIED": a row only ever appears in `votes`
// once the vote is real. A free vote is inserted when it is cast; a paid bundle
// inserts its row when the payment is CONFIRMED (routes/payments.js) or when an
// admin approves it (routes/competitions.js) — never at purchase. So there is no
// such thing as an unverified row to filter out, and SUM(bundle_size) is the
// exact figure the spec asks for rather than an optimistic one.
//
// Totals are always SUM(bundle_size), never a stored counter — the same choice
// the rest of this codebase makes, so a total cannot drift from the rows it is
// meant to describe.

const pool = require('../db');

// One vote row can be one of three things, and the split has to say which:
//
//   - from a paid bundle   vote_bundle_id IS NOT NULL   -> BULK
//   - an admin adjustment  session_id LIKE 'admin-adjust:%'
//   - everything else                                   -> ONLINE
//
// §8.5 asks for two numbers, online and bulk, so an adjustment is counted in
// the total (it is a real, verified vote) and reported on its own rather than
// being quietly folded into "online", which would tell a contestant they
// received votes from the public that they did not.
const BULK = `v.vote_bundle_id IS NOT NULL`;
const ADJUSTMENT = `v.session_id LIKE 'admin-adjust:%'`;

// Every entry belonging to this member, with everything §8.5 lists.
//
// Ranking is computed over the WHOLE competition (all approved entries), not
// over the member's own entries — a rank among your own entries is meaningless.
// Ties share a rank, which is what RANK() does and what a person expects: two
// contestants on 40 votes are both second.
async function entriesFor(userId, client = pool) {
  const id = Number(userId);
  if (!Number.isInteger(id)) return [];

  const r = await client.query(
    `WITH entry_totals AS (
       SELECT ce.id AS entry_id,
              ce.competition_id,
              COALESCE(SUM(v.bundle_size), 0)::int AS total_votes,
              COALESCE(SUM(v.bundle_size) FILTER (WHERE ${BULK}), 0)::int AS bulk_votes,
              COALESCE(SUM(v.bundle_size) FILTER (WHERE ${ADJUSTMENT}), 0)::int AS adjustment_votes
         FROM competition_entries ce
         LEFT JOIN votes v ON v.entry_id = ce.id
        GROUP BY ce.id, ce.competition_id
     ),
     ranked AS (
       -- Ranked among APPROVED entries only: a pending or rejected entry is not
       -- in the running, and including it would push everyone else down.
       SELECT t.entry_id,
              t.competition_id,
              t.total_votes,
              t.bulk_votes,
              t.adjustment_votes,
              RANK() OVER (PARTITION BY t.competition_id ORDER BY t.total_votes DESC) AS position,
              COUNT(*) OVER (PARTITION BY t.competition_id) AS contestants
         FROM entry_totals t
         JOIN competition_entries ce ON ce.id = t.entry_id
        WHERE ce.status = 'approved'
     )
     SELECT ce.id,
            ce.status,
            ce.entry_fee,
            ce.created_at,
            ce.entry_code,
            c.name  AS competition_name,
            c.slug  AS competition_slug,
            c.status AS competition_status,
            c.closes_at,
            COALESCE(r.total_votes, 0)      AS total_votes,
            COALESCE(r.bulk_votes, 0)       AS bulk_votes,
            COALESCE(r.adjustment_votes, 0) AS adjustment_votes,
            r.position,
            r.contestants
       FROM competition_entries ce
       JOIN competitions c ON c.id = ce.competition_id
       LEFT JOIN ranked r ON r.entry_id = ce.id
      WHERE ce.profile_id IN (SELECT id FROM profiles WHERE user_id = $1)
      ORDER BY ce.created_at DESC`,
    [id]
  );

  return r.rows.map((row) => {
    const total = Number(row.total_votes);
    const bulk = Number(row.bulk_votes);
    const adjustments = Number(row.adjustment_votes);
    return {
      id: row.id,
      status: row.status,
      entryFee: row.entry_fee === null ? null : Number(row.entry_fee),
      enteredAt: row.created_at,

      // §8.5: the contestant code. NULL until the entry is approved, because
      // that is when the trigger issues it — shown as null rather than as an
      // empty string so the page can say "issued when your entry is approved".
      entryCode: row.entry_code || null,

      competition: row.competition_name,
      competitionSlug: row.competition_slug,
      competitionStatus: row.competition_status,
      closesAt: row.closes_at,

      // §8.5's headline. Every row counted here is already verified.
      verifiedVotes: total,
      bulkVotes: bulk,
      // Online is what is left after paid bundles and admin adjustments — the
      // votes the public actually cast.
      onlineVotes: total - bulk - adjustments,
      adjustmentVotes: adjustments,

      // null for an entry that is not approved: it has no position in a
      // competition it is not yet part of.
      ranking: row.position === null ? null : Number(row.position),
      contestants: row.contestants === null ? null : Number(row.contestants),
    };
  });
}

module.exports = { entriesFor };
